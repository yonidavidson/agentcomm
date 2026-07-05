import { describe, it, expect, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';

const here = path.dirname(fileURLToPath(import.meta.url));
const cli = path.join(here, '..', 'src', 'cli.ts');

const tmpRoots: string[] = [];
async function mkTmp(): Promise<string> {
  const dir = path.join(os.tmpdir(), `agentcomm-${randomUUID()}`);
  await fs.mkdir(dir, { recursive: true });
  tmpRoots.push(dir);
  return dir;
}
afterEach(async () => {
  for (const dir of tmpRoots.splice(0)) await fs.rm(dir, { recursive: true, force: true });
});

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

function run(args: string[], input?: string, env?: NodeJS.ProcessEnv): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', cli, ...args], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: env ?? process.env,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d.toString()));
    child.stderr.on('data', (d) => (stderr += d.toString()));
    child.on('error', reject);
    child.on('exit', (code) => resolve({ code: code ?? -1, stdout, stderr }));
    if (input !== undefined) child.stdin.write(input);
    child.stdin.end();
  });
}

// Run every CLI case against the sqlite backend (Task 1 acceptance: identical
// behaviour to file://).
describe('CLI e2e (sqlite backend)', () => {
  it('register → agents → send → inbox round-trips, --json parses', async () => {
    const db = `sqlite://${path.join(await mkTmp(), 'bus.db')}`;

    const reg = await run(['register', '--as', 'alice', '--backend', db]);
    expect(reg.code).toBe(0);

    await run(['register', '--as', 'bob', '--backend', db]);

    const agents = await run(['agents', '--backend', db, '--json']);
    expect(agents.code).toBe(0);
    const names = (JSON.parse(agents.stdout) as { name: string }[]).map((a) => a.name);
    expect(names).toEqual(['alice', 'bob']);

    const send = await run(['send', 'bob', 'ship it', '--as', 'alice', '--backend', db, '--json']);
    expect(send.code).toBe(0);
    expect(JSON.parse(send.stdout).to).toBe('bob');

    const inbox = await run(['inbox', '--as', 'bob', '--backend', db, '--json']);
    expect(inbox.code).toBe(0);
    const msgs = JSON.parse(inbox.stdout) as { body: string; from: string }[];
    expect(msgs).toHaveLength(1);
    expect(msgs[0]!.body).toBe('ship it');

    // consumed
    const empty = await run(['inbox', '--as', 'bob', '--backend', db, '--json']);
    expect(JSON.parse(empty.stdout)).toEqual([]);
  });

  it('send reads body from stdin when no body arg', async () => {
    const db = `sqlite://${path.join(await mkTmp(), 'bus.db')}`;
    await run(['send', 'bob', '--as', 'alice', '--backend', db], 'from stdin');
    const inbox = await run(['inbox', '--as', 'bob', '--backend', db, '--json']);
    expect((JSON.parse(inbox.stdout) as { body: string }[])[0]!.body).toBe('from stdin');
  });

  it('send via stdin preserves leading whitespace and internal formatting, stripping only the trailing pipe newline', async () => {
    const db = `sqlite://${path.join(await mkTmp(), 'bus.db')}`;
    const art = '   |\\\n   | \\\n___|__\\__';
    await run(['send', 'bob', '--as', 'alice', '--backend', db], art + '\n');
    const inbox = await run(['inbox', '--as', 'bob', '--backend', db, '--json']);
    expect((JSON.parse(inbox.stdout) as { body: string }[])[0]!.body).toBe(art);
  });

  it('wait exits 0 when a message is pending', async () => {
    const db = `sqlite://${path.join(await mkTmp(), 'bus.db')}`;
    await run(['send', 'bob', 'hello', '--as', 'alice', '--backend', db]);
    const w = await run(['wait', '--as', 'bob', '--backend', db, '--timeout', '1000', '--json']);
    expect(w.code).toBe(0);
    expect(JSON.parse(w.stdout)).toHaveLength(1);
  });

  it('wait exits 2 on timeout', async () => {
    const db = `sqlite://${path.join(await mkTmp(), 'bus.db')}`;
    const w = await run(['wait', '--as', 'bob', '--backend', db, '--timeout', '150']);
    expect(w.code).toBe(2);
  });

  it('missing --as derives an alias instead of failing, and says so', async () => {
    const db = `sqlite://${path.join(await mkTmp(), 'bus.db')}`;
    const r = await run(['inbox', '--backend', db]);
    expect(r.code).toBe(0);
    expect(r.stderr).toMatch(/acting as [A-Za-z0-9._-]+ \((from git config user\.email|OS username)/);
  });

  it('claim dequeues atomically and reports an empty queue', async () => {
    const db = `sqlite://${path.join(await mkTmp(), 'bus.db')}`;
    await run(['send', 'work-queue', 'task-1', '--as', 'producer', '--backend', db]);

    const claimed = await run(['claim', '--queue', 'work-queue', '--as', 'worker-1', '--backend', db, '--json']);
    expect(claimed.code).toBe(0);
    expect(JSON.parse(claimed.stdout).body).toBe('task-1');

    const empty = await run(['claim', '--queue', 'work-queue', '--as', 'worker-1', '--backend', db, '--json']);
    expect(empty.code).toBe(0);
    expect(JSON.parse(empty.stdout)).toBeNull();
  });

  it('claim requires --queue', async () => {
    const db = `sqlite://${path.join(await mkTmp(), 'bus.db')}`;
    const r = await run(['claim', '--as', 'worker-1', '--backend', db]);
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/--queue/);
  });

  it('claim errors cleanly on a non-SQL (file://) backend', async () => {
    const dir = `file://${await mkTmp()}`;
    const r = await run(['claim', '--queue', 'work-queue', '--as', 'worker-1', '--backend', dir]);
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/does not support claim/);
  });

  it('AGENTCOMM_BACKEND_PLUGINS loads a third-party backend module before resolving --backend', async () => {
    // Simulates an external npm package: a standalone module whose only job,
    // on import, is to call registerBackend() for a brand-new URI scheme.
    // agentcomm itself never references "pluginfs" anywhere.
    const root = await mkTmp();
    const dataDir = path.join(root, 'data');
    const pluginPath = path.join(root, 'plugin.mjs');
    const indexUrl = pathToFileURL(path.join(here, '..', 'src', 'backends', 'index.ts')).href;
    const localUrl = pathToFileURL(path.join(here, '..', 'src', 'backends', 'local.ts')).href;
    await fs.writeFile(
      pluginPath,
      [
        `import { registerBackend } from ${JSON.stringify(indexUrl)};`,
        `import { LocalBackend } from ${JSON.stringify(localUrl)};`,
        `registerBackend('pluginfs', async () => new LocalBackend(${JSON.stringify(dataDir)}));`,
      ].join('\n'),
    );

    const env = { ...process.env, AGENTCOMM_BACKEND_PLUGINS: pathToFileURL(pluginPath).href };
    const reg = await run(['register', '--as', 'alice', '--backend', 'pluginfs://ignored'], undefined, env);
    expect(reg.code).toBe(0);
    expect(reg.stdout).toMatch(/registered alice/);

    // Proves the plugin's factory actually ran: data landed in dataDir.
    const written = await fs.readdir(path.join(dataDir, 'agents'));
    expect(written).toContain('alice.json');
  });

  it('an unknown scheme lists the currently registered ones in the error', async () => {
    const r = await run(['inbox', '--as', 'alice', '--backend', 'redis://localhost']);
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/Known schemes: file, git\+file, git\+http, git\+https, git\+ssh, github, gs, postgres, postgresql, s3, sqlite/);
  });
});
