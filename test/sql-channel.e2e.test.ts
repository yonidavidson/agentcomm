/**
 * e2e for `?channel=` on SQL backends (issue #9) — sqlite side, through the
 * real CLI. One .db file hosts N isolated buses selected purely by connection
 * string. Postgres-side channel tests (incl. the NOTIFY cross-wake
 * regression) live in test/postgres.test.ts with the rest of the gated suite.
 */
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
  const dir = path.join(os.tmpdir(), `agentcomm-chan-${randomUUID()}`);
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

function run(args: string[]): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', cli, ...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d.toString()));
    child.stderr.on('data', (d) => (stderr += d.toString()));
    child.on('error', reject);
    child.on('exit', (code) => resolve({ code: code ?? -1, stdout, stderr }));
  });
}

describe('sqlite ?channel= (N isolated buses in one .db, via the real CLI)', () => {
  it('registrations and messages are fully isolated between channels and the root', async () => {
    const db = `sqlite://${path.join(await mkTmp(), 'bus.db')}`;
    const a = `${db}?channel=team-a`;
    const b = `${db}?channel=team-b`;

    await run(['register', '--as', 'alice', '--backend', a]);
    await run(['register', '--as', 'bob', '--backend', b]);
    await run(['register', '--as', 'carol', '--backend', db]); // root

    for (const [uri, expected] of [
      [a, ['alice']],
      [b, ['bob']],
      [db, ['carol']],
    ] as const) {
      const agents = await run(['agents', '--backend', uri, '--json']);
      expect((JSON.parse(agents.stdout) as { name: string }[]).map((x) => x.name)).toEqual([...expected]);
    }

    // Same recipient name, different channels — messages don't leak.
    await run(['send', 'shared', 'for team-a', '--as', 'alice', '--backend', a]);
    const inboxB = await run(['inbox', '--as', 'shared', '--backend', b, '--json']);
    expect(JSON.parse(inboxB.stdout)).toEqual([]);
    const inboxA = await run(['inbox', '--as', 'shared', '--backend', a, '--json']);
    expect((JSON.parse(inboxA.stdout) as { body: string }[]).map((m) => m.body)).toEqual(['for team-a']);
  });

  it('the same queue name claims independently per channel', async () => {
    const db = `sqlite://${path.join(await mkTmp(), 'bus.db')}`;
    const a = `${db}?channel=team-a`;
    const b = `${db}?channel=team-b`;

    await run(['send', 'work-queue', 'task-a', '--as', 'producer', '--backend', a]);
    await run(['send', 'work-queue', 'task-b', '--as', 'producer', '--backend', b]);

    const claimedA = await run(['claim', '--queue', 'work-queue', '--as', 'w', '--backend', a, '--json']);
    expect(JSON.parse(claimedA.stdout).body).toBe('task-a');
    expect(JSON.parse((await run(['claim', '--queue', 'work-queue', '--as', 'w', '--backend', a, '--json'])).stdout)).toBeNull();

    // team-b's task is still there, untouched by team-a's claims.
    const claimedB = await run(['claim', '--queue', 'work-queue', '--as', 'w', '--backend', b, '--json']);
    expect(JSON.parse(claimedB.stdout).body).toBe('task-b');
  });

  it('channels enumeration returns ready-to-use ?channel= URIs alongside the root', async () => {
    const db = `sqlite://${path.join(await mkTmp(), 'bus.db')}`;
    await run(['register', '--as', 'root-agent', '--backend', db]);
    await run(['register', '--as', 'alice', '--backend', `${db}?channel=team-a`]);
    await run(['register', '--as', 'bob', '--backend', `${db}?channel=team-b`]);

    const r = await run(['channels', '--backend', db, '--json']);
    const rows = JSON.parse(r.stdout) as { prefix: string; agents: number; uri: string | null }[];
    expect(rows).toEqual([
      { prefix: '', agents: 1, uri: db },
      { prefix: 'channels/team-a', agents: 1, uri: `${db}?channel=team-a` },
      { prefix: 'channels/team-b', agents: 1, uri: `${db}?channel=team-b` },
    ]);
  });

  it('root-channel data written before channels existed stays readable next to channel data', async () => {
    const db = `sqlite://${path.join(await mkTmp(), 'bus.db')}`;
    await run(['send', 'bob', 'pre-channel message', '--as', 'alice', '--backend', db]);
    await run(['send', 'bob', 'channel message', '--as', 'alice', '--backend', `${db}?channel=team-a`]);

    const rootInbox = await run(['inbox', '--as', 'bob', '--backend', db, '--json']);
    expect((JSON.parse(rootInbox.stdout) as { body: string }[]).map((m) => m.body)).toEqual(['pre-channel message']);
  });

  it('rejects invalid channel names, unknown query params, and ?channel= on file://', async () => {
    const dir = await mkTmp();
    const db = `sqlite://${path.join(dir, 'bus.db')}`;

    const bad = await run(['register', '--as', 'x', '--backend', `${db}?channel=team/a`]);
    expect(bad.code).toBe(1);
    expect(bad.stderr).toMatch(/invalid channel name/);

    const typo = await run(['register', '--as', 'x', '--backend', `${db}?chanel=a`]);
    expect(typo.code).toBe(1);
    expect(typo.stderr).toMatch(/unsupported query parameter/);

    const file = await run(['register', '--as', 'x', '--backend', `file://${dir}?channel=a`]);
    expect(file.code).toBe(1);
    expect(file.stderr).toMatch(/carves channels by path/);
  });
});
