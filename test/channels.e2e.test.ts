/**
 * e2e for `agentcomm channels` — channel enumeration (issue #8). Everything
 * runs through the real CLI; channels are created the way real agents create
 * them (register/send), never by hand-crafting keys.
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
  const dir = path.join(os.tmpdir(), `agentcomm-channels-${randomUUID()}`);
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

interface ChannelRow {
  prefix: string;
  agents: number;
  uri: string | null;
}

describe('CLI channels (enumerate existing channels on a store)', () => {
  it('file store: finds root + two carved channels with agent counts, ignores unrelated files', async () => {
    const root = await mkTmp();
    const store = `file://${root}`;

    // Root channel: one registered agent. team-a: one agent. team-b: traffic
    // but no registrations (agents: 0). Plus an unrelated file tree that must
    // not read as a channel.
    await run(['register', '--as', 'alice', '--backend', store]);
    await run(['register', '--as', 'bob', '--backend', `${store}/team-a`]);
    await run(['send', 'builder', 'task 1', '--as', 'producer', '--backend', `${store}/team-b`]);
    await fs.mkdir(path.join(root, 'random', 'stuff'), { recursive: true });
    await fs.writeFile(path.join(root, 'random', 'stuff', 'notes.txt'), 'not a channel');

    const r = await run(['channels', '--backend', store, '--json']);
    expect(r.code).toBe(0);
    const rows = JSON.parse(r.stdout) as ChannelRow[];
    expect(rows.map((c) => c.prefix)).toEqual(['', 'team-a', 'team-b']);
    expect(rows.map((c) => c.agents)).toEqual([1, 1, 0]);
    // URIs are copy-paste ready
    expect(rows[1]!.uri).toBe(`${store}/team-a`);
  });

  it('nested channels both appear', async () => {
    const store = `file://${await mkTmp()}`;
    await run(['register', '--as', 'outer', '--backend', `${store}/team-a`]);
    await run(['register', '--as', 'inner', '--backend', `${store}/team-a/experiments`]);

    const rows = JSON.parse((await run(['channels', '--backend', store, '--json'])).stdout) as ChannelRow[];
    expect(rows.map((c) => c.prefix)).toEqual(['team-a', 'team-a/experiments']);
  });

  it('a recipient literally named "agents" does not fabricate a phantom channel', async () => {
    const store = `file://${await mkTmp()}`;
    await run(['send', 'agents', 'tricky', '--as', 'alice', '--backend', store]);

    const rows = JSON.parse((await run(['channels', '--backend', store, '--json'])).stdout) as ChannelRow[];
    expect(rows.map((c) => c.prefix)).toEqual(['']); // root only — no 'inbox' phantom
  });

  it('empty store reports no channels, exit 0', async () => {
    const r = await run(['channels', '--backend', `file://${await mkTmp()}`]);
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/no channels found/);
  });

  it('sqlite store reports its single-channel reality with the store URI itself', async () => {
    const db = `sqlite://${path.join(await mkTmp(), 'bus.db')}`;
    await run(['register', '--as', 'alice', '--backend', db]);

    const rows = JSON.parse((await run(['channels', '--backend', db, '--json'])).stdout) as ChannelRow[];
    expect(rows).toEqual([{ prefix: '', agents: 1, uri: db }]);
  });

  it('human output lists ready-to-use URIs with agent counts', async () => {
    const store = `file://${await mkTmp()}`;
    await run(['register', '--as', 'a1', '--backend', `${store}/team-a`]);
    await run(['register', '--as', 'a2', '--backend', `${store}/team-a`]);

    const r = await run(['channels', '--backend', store]);
    expect(r.stdout).toMatch(/channels on .* \(1\)/);
    expect(r.stdout).toContain(`${store}/team-a  — 2 agents`);
  });
});
