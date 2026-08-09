/**
 * e2e for mailbox leases (issue #161).
 *
 * A subagent inherits its parent's git identity and process tree, so it
 * derives the parent's alias — and since reads consume, one `agentcomm inbox`
 * from a subagent drains the mailbox its parent is waiting on. The alias
 * stays per-session on purpose; what these cover is that sharing one is no
 * longer silent.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';

const here = path.dirname(fileURLToPath(import.meta.url));
const cli = path.join(here, '..', 'src', 'cli.ts');
const tsx = pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href;

const tmpRoots: string[] = [];
async function mkTmp(): Promise<string> {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'agentcomm-lease-')));
  tmpRoots.push(dir);
  return dir;
}
afterEach(async () => {
  for (const dir of tmpRoots.splice(0)) await fs.rm(dir, { recursive: true, force: true });
});

interface Ctx {
  dir: string;
  state: string;
}

function spawnCli(args: string[], ctx: Ctx): ReturnType<typeof spawn> {
  return spawn(process.execPath, ['--import', tsx, cli, ...args], {
    stdio: ['ignore', 'pipe', 'pipe'],
    cwd: ctx.dir,
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      AGENTCOMM_BACKEND: `file://${path.join(ctx.dir, '.bus')}`,
      AGENTCOMM_NO_GIT_PROBE: '1',
      AGENTCOMM_SESSION: 'lease-test',
      AGENTCOMM_STATE_DIR: ctx.state,
    },
  });
}

function run(args: string[], ctx: Ctx): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawnCli(args, ctx);
    let stdout = '';
    let stderr = '';
    child.stdout!.on('data', (d) => (stdout += d.toString()));
    child.stderr!.on('data', (d) => (stderr += d.toString()));
    child.on('error', reject);
    child.on('exit', (code) => resolve({ code: code ?? -1, stdout, stderr }));
  });
}

async function ctx(): Promise<Ctx> {
  return { dir: await mkTmp(), state: await mkTmp() };
}

describe('mailbox leases: sharing an alias stops being silent (issue #161)', () => {
  it('a consuming read warns while another live process holds the same alias', async () => {
    const c = await ctx();
    // the "parent": a listener blocked on its own mailbox, holding it
    const listener = spawnCli(['wait', '--as', 'worker', '--timeout', '8000'], c);
    await new Promise((r) => setTimeout(r, 1200)); // let it take the lease

    // the "subagent": same alias, consuming read — the mail it drains would
    // have been the listener's
    const drain = await run(['inbox', '--as', 'worker', '--json'], c);
    expect(drain.stderr).toMatch(/WARNING — another live process of this session is acting as "worker"/);
    expect(drain.stderr).toMatch(/agentcomm wait/); // says what that process is doing
    expect(drain.stderr).toMatch(/--as worker-<role>/); // and the remedy

    listener.kill('SIGKILL');
  });

  it('says nothing when nobody else holds the alias, and cleans up after itself', async () => {
    const c = await ctx();
    await run(['send', 'solo', 'hello', '--as', 'boss'], c);

    const first = await run(['inbox', '--as', 'solo'], c);
    expect(first.stderr).not.toMatch(/WARNING/);
    // the lease is released at exit — the NEXT command must not see a ghost
    const second = await run(['inbox', '--as', 'solo'], c);
    expect(second.stderr).not.toMatch(/WARNING/);
    expect((await fs.readdir(c.state)).filter((f) => f.startsWith('lease-'))).toEqual([]);
  });

  it('a status write onto an alias another process is holding says whose line it replaces', async () => {
    const c = await ctx();
    const listener = spawnCli(['wait', '--as', 'shared', '--timeout', '8000'], c);
    await new Promise((r) => setTimeout(r, 1200));

    const status = await run(['register', '--as', 'shared', '--status', 'subagent work'], c);
    expect(status.stderr).toMatch(/WARNING — another live process of this session is acting as "shared"/);
    expect(status.stderr).toMatch(/replaces its line on the shared roster/);

    // a plain heartbeat is not a claim on the roster — no warning
    const heartbeat = await run(['register', '--as', 'shared'], c);
    expect(heartbeat.stderr).not.toMatch(/WARNING/);

    listener.kill('SIGKILL');
  });

  it('a lease left by a dead process is ignored, not inherited', async () => {
    const c = await ctx();
    await fs.writeFile(
      path.join(c.state, 'lease-ghost-999999.json'),
      JSON.stringify({ alias: 'ghost', pid: 999999, command: 'wait', since: new Date().toISOString() }),
    );
    const r = await run(['inbox', '--as', 'ghost'], c);
    expect(r.stderr).not.toMatch(/WARNING/);
    expect(await fs.readdir(c.state)).not.toContain('lease-ghost-999999.json');
  });
});
