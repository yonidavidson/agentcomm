import { describe, it, expect, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
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

function run(args: string[], input?: string): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', cli, ...args], {
      stdio: ['pipe', 'pipe', 'pipe'],
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

  it('missing --as fails clearly', async () => {
    const db = `sqlite://${path.join(await mkTmp(), 'bus.db')}`;
    const r = await run(['inbox', '--backend', db]);
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/acting agent/);
  });
});
