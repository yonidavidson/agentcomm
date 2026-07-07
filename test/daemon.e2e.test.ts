/**
 * e2e for the bus daemon (issue #57): a background poller serving the bus
 * over a unix socket, transparent under the Backend seam — same commands,
 * flags, and exit codes, just immediate.
 */
import { describe, it, expect, afterEach, beforeAll } from 'vitest';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, execFileSync } from 'node:child_process';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const CLI = path.join(root, 'dist', 'cli.js');

beforeAll(() => {
  execFileSync('npm', ['run', 'build'], { cwd: root, stdio: 'ignore' });
});

const tmpRoots: string[] = [];
async function mkTmp(): Promise<string> {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'agentcomm-daemon-')));
  tmpRoots.push(dir);
  return dir;
}

function env(dir: string, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    AGENTCOMM_BACKEND: `file://${path.join(dir, '.bus')}`,
    AGENTCOMM_DAEMON_DIR: path.join(dir, 'dsock'),
    AGENTCOMM_POLL_MS: '300',
    AGENTCOMM_SESSION: 'daemon-test',
    AGENTCOMM_NO_GIT_PROBE: '1',
    AGENTCOMM_DAEMON_SPAWN_WAIT_MS: '30000', // CI runners under parallel load start node slowly
    ...extra,
  };
}

function run(
  args: string[],
  dir: string,
  extraEnv: Record<string, string> = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
      cwd: dir,
      env: env(dir, extraEnv),
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d.toString()));
    child.stderr.on('data', (d) => (stderr += d.toString()));
    child.on('error', reject);
    child.on('exit', (code) => resolve({ code: code ?? -1, stdout, stderr }));
  });
}

afterEach(async () => {
  for (const dir of tmpRoots.splice(0)) {
    await run(['daemon', 'stop'], dir).catch(() => {});
    // stop acks before the daemon fully exits (it drains its outbox first) —
    // wait for the pid file to disappear so rm doesn't race daemon writes
    const dsock = path.join(dir, 'dsock');
    for (let i = 0; i < 30; i++) {
      let alive = false;
      try {
        alive = (await fs.readdir(dsock)).some((f) => f.endsWith('.pid'));
      } catch {
        break; // no daemon dir at all
      }
      if (!alive) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});

describe('bus daemon: same semantics, immediate answers', () => {
  it('autostarts on --daemon, reports status, and preserves read-your-write', async () => {
    const dir = await mkTmp();

    const reg = await run(['register', '--as', 'alpha', '--daemon'], dir);
    expect(reg.code, reg.stderr).toBe(0);
    expect(reg.stdout).toContain('registered alpha');

    const status = await run(['daemon', 'status', '--json'], dir);
    expect(status.code, status.stderr).toBe(0);
    const info = JSON.parse(status.stdout) as { running: boolean; pollMs: number; claimable: boolean };
    expect(info.running).toBe(true);
    expect(info.pollMs).toBe(500); // AGENTCOMM_POLL_MS=300 clamped to the 500ms floor
    expect(info.claimable).toBe(false); // file:// backend

    // write through the daemon, read through the daemon — immediately visible
    await run(['send', 'alpha', 'to myself', '--as', 'alpha', '--daemon'], dir);
    const peek = await run(['peek', '--as', 'alpha', '--daemon', '--json'], dir);
    expect((JSON.parse(peek.stdout) as unknown[]).length).toBe(1);
  });

  it('sees foreign --direct writes within one poll interval', async () => {
    const dir = await mkTmp();
    await run(['register', '--as', 'alpha', '--daemon'], dir);

    await run(['send', 'alpha', 'behind the back', '--as', 'beta', '--direct'], dir);

    let seen = 0;
    for (let i = 0; i < 15 && !seen; i++) {
      await new Promise((r) => setTimeout(r, 200));
      const peek = await run(['peek', '--as', 'alpha', '--daemon', '--json'], dir);
      seen = (JSON.parse(peek.stdout) as unknown[]).length;
    }
    expect(seen).toBe(1);
  });

  it('wait keeps its exit-code contract through the daemon (2 = timeout, 0 = delivered)', async () => {
    const dir = await mkTmp();
    await run(['register', '--as', 'alpha', '--daemon'], dir);

    const timeout = await run(['wait', '--as', 'alpha', '--daemon', '--timeout', '700'], dir);
    expect(timeout.code).toBe(2);

    await run(['send', 'alpha', 'ping', '--as', 'beta', '--daemon'], dir);
    const delivered = await run(['wait', '--as', 'alpha', '--daemon', '--timeout', '5000'], dir);
    expect(delivered.code).toBe(0);
  });

  it('claim semantics are preserved: file:// still refuses, through the daemon too', async () => {
    const dir = await mkTmp();
    await run(['register', '--as', 'w1', '--daemon'], dir);
    const r = await run(['claim', '--queue', 'q', '--as', 'w1', '--daemon'], dir);
    expect(r.code).not.toBe(0);
    expect(r.stderr.toLowerCase()).toMatch(/claim/);
  });

  it('inbox consumption goes through: message moves to read/ exactly once', async () => {
    const dir = await mkTmp();
    await run(['register', '--as', 'alpha', '--daemon'], dir);
    await run(['send', 'alpha', 'consume me', '--as', 'beta', '--daemon'], dir);

    const first = await run(['inbox', '--as', 'alpha', '--daemon', '--json'], dir);
    expect((JSON.parse(first.stdout) as unknown[]).length).toBe(1);
    const second = await run(['inbox', '--as', 'alpha', '--daemon', '--json'], dir);
    expect((JSON.parse(second.stdout) as unknown[]).length).toBe(0);

    // the consumption is real on the store: a --direct reader agrees
    const direct = await run(['peek', '--as', 'alpha', '--direct', '--json'], dir);
    expect((JSON.parse(direct.stdout) as unknown[]).length).toBe(0);
  });

  it('a second daemon for the same bus bows out instead of stealing the socket', async () => {
    const dir = await mkTmp();
    await run(['register', '--as', 'alpha', '--daemon'], dir);
    const before = JSON.parse((await run(['daemon', 'status', '--json'], dir)).stdout) as { pid: number };

    // start a rival daemon in the foreground: it must exit 0 immediately
    const rival = await run(['daemon', 'run'], dir);
    expect(rival.code).toBe(0);
    expect(rival.stderr).toContain('already serves');

    const after = JSON.parse((await run(['daemon', 'status', '--json'], dir)).stdout) as { pid: number };
    expect(after.pid).toBe(before.pid); // the incumbent survived untouched
  });

  it('daemon housekeeping drops stale registrations on its own clock', async () => {
    const dir = await mkTmp();
    await run(['register', '--as', 'fresh-agent', '--daemon'], dir);
    await run(['register', '--as', 'ancient-agent', '--direct'], dir);
    const rec = path.join(dir, '.bus', 'agents', 'ancient-agent.json');
    const parsed = JSON.parse(await fs.readFile(rec, 'utf8')) as { lastSeen: string };
    parsed.lastSeen = new Date(Date.now() - 8 * 86400_000).toISOString();
    await fs.writeFile(rec, JSON.stringify(parsed));

    // a session-derived alias (suffix = its session hash) ages on the FAST
    // clock: 13h stale kills it while a 13h-stale ROLE would survive (7d)
    const sessRec = path.join(dir, '.bus', 'agents', 'ghost-ab12.json');
    await fs.writeFile(sessRec, JSON.stringify({
      name: 'ghost-ab12',
      registeredAt: new Date(Date.now() - 86400_000).toISOString(),
      lastSeen: new Date(Date.now() - 13 * 3600_000).toISOString(),
      session: 'ab12ffffffff',
    }));
    const roleRec = path.join(dir, '.bus', 'agents', 'night-reviewer.json');
    await fs.writeFile(roleRec, JSON.stringify({
      name: 'night-reviewer',
      registeredAt: new Date(Date.now() - 86400_000).toISOString(),
      lastSeen: new Date(Date.now() - 13 * 3600_000).toISOString(),
      session: 'cccc00000000', // has a session but name lacks the suffix → role
    }));

    // restart the daemon with a fast housekeeping clock
    await run(['daemon', 'stop'], dir);
    const child = spawn(process.execPath, [CLI, 'daemon', 'run'], {
      stdio: 'ignore',
      detached: true,
      cwd: dir,
      env: { ...env(dir), AGENTCOMM_HOUSEKEEP_MS: '10000' },
    });
    child.unref();

    // first sweep runs ~15s after start
    let names: string[] = [];
    for (let i = 0; i < 40; i++) {
      await new Promise((r) => setTimeout(r, 500));
      const roster = await run(['agents', '--daemon', '--json'], dir);
      names = (JSON.parse(roster.stdout) as { name: string }[]).map((a) => a.name);
      if (!names.some((n) => n === 'ancient-agent')) break;
    }
    expect(names).toContain('fresh-agent');
    expect(names).not.toContain('ancient-agent');
    expect(names).not.toContain('ghost-ab12'); // session alias, fast clock
    expect(names).toContain('night-reviewer'); // role alias, slow clock
  }, 40_000);

  it('async sends: instant local visibility, remote after drain; --sync goes straight through', async () => {
    const dir = await mkTmp();
    const FROZEN = { AGENTCOMM_FLUSH_MS: '600000' }; // flusher effectively off
    await run(['register', '--as', 'alpha', '--daemon'], dir, FROZEN);

    await run(['send', 'alpha', 'queued message', '--as', 'beta', '--daemon'], dir, FROZEN);
    const local = await run(['peek', '--as', 'alpha', '--daemon', '--json'], dir, FROZEN);
    expect((JSON.parse(local.stdout) as unknown[]).length).toBe(1); // mirror sees it instantly
    const remote = await run(['peek', '--as', 'alpha', '--direct', '--json'], dir);
    expect((JSON.parse(remote.stdout) as unknown[]).length).toBe(0); // store does NOT yet

    const status = await run(['daemon', 'status', '--json'], dir, FROZEN);
    expect((JSON.parse(status.stdout) as { outbox: number }).outbox).toBeGreaterThan(0);

    // stop drains the outbox before exit
    await run(['daemon', 'stop'], dir);
    let onStore = 0;
    for (let i = 0; i < 20 && !onStore; i++) {
      await new Promise((r) => setTimeout(r, 250));
      const after = await run(['peek', '--as', 'alpha', '--direct', '--json'], dir);
      onStore = (JSON.parse(after.stdout) as unknown[]).length;
    }
    expect(onStore).toBe(1);

    // --sync bypasses the outbox: durable on the store before the CLI returns
    await run(['send', 'alpha', 'sync message', '--as', 'beta', '--daemon', '--sync'], dir, FROZEN);
    const syncRemote = await run(['peek', '--as', 'alpha', '--direct', '--json'], dir);
    expect((JSON.parse(syncRemote.stdout) as unknown[]).length).toBe(2);
  });

  it('outbox survives a daemon crash: a fresh daemon delivers the leftovers', async () => {
    const dir = await mkTmp();
    const FROZEN = { AGENTCOMM_FLUSH_MS: '600000' };
    await run(['register', '--as', 'alpha', '--daemon'], dir, FROZEN);
    await run(['send', 'alpha', 'survives the crash', '--as', 'beta', '--daemon'], dir, FROZEN);

    const status = await run(['daemon', 'status', '--json'], dir, FROZEN);
    const pid = (JSON.parse(status.stdout) as { pid: number }).pid;
    process.kill(pid, 'SIGKILL'); // no drain, no cleanup
    await new Promise((r) => setTimeout(r, 300));

    const gone = await run(['peek', '--as', 'alpha', '--direct', '--json'], dir);
    expect((JSON.parse(gone.stdout) as unknown[]).length).toBe(0); // spooled, not delivered

    // any daemon-path command respawns; startup flush delivers the leftovers
    await run(['agents', '--daemon', '--json'], dir, { AGENTCOMM_FLUSH_MS: '200' });
    let onStore = 0;
    for (let i = 0; i < 30 && !onStore; i++) {
      await new Promise((r) => setTimeout(r, 250));
      const after = await run(['peek', '--as', 'alpha', '--direct', '--json'], dir);
      onStore = (JSON.parse(after.stdout) as unknown[]).length;
    }
    expect(onStore).toBe(1);
  }, 30_000);

  it('spooled sends arrive in send order', async () => {
    const dir = await mkTmp();
    const FAST = { AGENTCOMM_FLUSH_MS: '150' };
    await run(['register', '--as', 'alpha', '--daemon'], dir, FAST);
    for (const n of ['first', 'second', 'third']) {
      await run(['send', 'alpha', n, '--as', 'beta', '--daemon'], dir, FAST);
    }
    let bodies: string[] = [];
    for (let i = 0; i < 30 && bodies.length < 3; i++) {
      await new Promise((r) => setTimeout(r, 250));
      const remote = await run(['peek', '--as', 'alpha', '--direct', '--json'], dir);
      bodies = (JSON.parse(remote.stdout) as { body: string }[]).map((m) => m.body);
    }
    expect(bodies).toEqual(['first', 'second', 'third']);
  }, 20_000);

  it('daemon stop leaves the CLI fully functional (fallback + respawn)', async () => {
    const dir = await mkTmp();
    await run(['register', '--as', 'alpha', '--daemon'], dir);
    const stop = await run(['daemon', 'stop'], dir);
    expect(stop.stdout).toContain('daemon stopped');

    const direct = await run(['agents', '--direct', '--json'], dir);
    expect(direct.code).toBe(0);

    const respawn = await run(['agents', '--daemon', '--json'], dir);
    expect(respawn.code).toBe(0);
    const status = await run(['daemon', 'status', '--json'], dir);
    expect((JSON.parse(status.stdout) as { running: boolean }).running).toBe(true);
  });
});
