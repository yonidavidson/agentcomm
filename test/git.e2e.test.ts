/**
 * e2e for the generic git backend (issue #23) — runs entirely offline
 * against LOCAL BARE repos via git+file://, so CI exercises the full real
 * path (fetch → plumbing → push) with zero services. The same code drives
 * git+ssh:// and git+https:// against any host.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import { GitBackend } from '../src/backends/git.js';
import { createBackend } from '../src/backends/index.js';
import { Bus } from '../src/bus.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const cli = path.join(here, '..', 'src', 'cli.ts');
const tsx = pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href;

const tmpRoots: string[] = [];
async function mkTmp(): Promise<string> {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'agentcomm-git-')));
  tmpRoots.push(dir);
  return dir;
}
afterEach(async () => {
  for (const dir of tmpRoots.splice(0)) await fs.rm(dir, { recursive: true, force: true });
});

/** A fresh bare remote + an isolated cache dir; returns the git+file URI base. */
async function bareRemote(): Promise<{ uri: string; cache: string }> {
  const root = await mkTmp();
  const remote = path.join(root, 'remote.git');
  execFileSync('git', ['init', '--bare', '--quiet', remote]);
  const cache = path.join(root, 'cache');
  return { uri: `git+file://${remote}`, cache };
}

async function open(uri: string, cache: string): Promise<GitBackend> {
  const prev = process.env.AGENTCOMM_GIT_CACHE_DIR;
  process.env.AGENTCOMM_GIT_CACHE_DIR = cache;
  try {
    return (await createBackend(uri)) as GitBackend;
  } finally {
    if (prev === undefined) delete process.env.AGENTCOMM_GIT_CACHE_DIR;
    else process.env.AGENTCOMM_GIT_CACHE_DIR = prev;
  }
}

describe('GitBackend (local bare remotes — same code path as any host)', () => {
  it('Backend contract: round-trip, overwrite, exists, delete no-op, missing key, prefix listing', async () => {
    const { uri, cache } = await bareRemote();
    const b = await open(uri, cache);

    await b.put('inbox/a/001.json', Buffer.from('hello'));
    expect((await b.get('inbox/a/001.json')).toString()).toBe('hello');
    await b.put('inbox/a/001.json', Buffer.from('hello v2'));
    expect((await b.get('inbox/a/001.json')).toString()).toBe('hello v2');

    expect(await b.exists('inbox/a/001.json')).toBe(true);
    expect(await b.exists('nope')).toBe(false);
    await expect(b.get('nope')).rejects.toThrow(/key not found/);

    await b.put('inbox/a/002.json', Buffer.from('2'));
    await b.put('inbox/ab/001.json', Buffer.from('x')); // 'inbox/a' prefixes 'inbox/ab'
    expect(await b.list('inbox/a/')).toEqual(['inbox/a/001.json', 'inbox/a/002.json']);

    await b.delete('inbox/a/001.json');
    expect(await b.exists('inbox/a/001.json')).toBe(false);
    await expect(b.delete('inbox/a/001.json')).resolves.toBeUndefined();
  }, 60000);

  it('snapshot: one pass returns every key + body, honors prefixes (issue #144)', async () => {
    const { uri, cache } = await bareRemote();
    const b = await open(uri, cache);

    expect((await b.snapshot('')).size).toBe(0); // branch not born yet

    await b.put('inbox/a/001.json', Buffer.from('one'));
    await b.put('inbox/b/001.json', Buffer.from('two'));
    await b.put('agents/a.json', Buffer.from('{"alias":"a"}'));

    const all = await b.snapshot('');
    expect([...all.keys()].sort()).toEqual(['agents/a.json', 'inbox/a/001.json', 'inbox/b/001.json']);
    for (const [k, v] of all) expect(v.equals(await b.get(k))).toBe(true); // bodies match per-key reads

    expect([...(await b.snapshot('inbox/a/')).keys()]).toEqual(['inbox/a/001.json']);
  }, 60000);

  it('move is ATOMIC — one commit relocates the key', async () => {
    const { uri, cache } = await bareRemote();
    const b = await open(uri, cache);
    await b.put('inbox/a/1.json', Buffer.from('payload'));
    await b.move('inbox/a/1.json', 'read/a/1.json');
    expect(await b.exists('inbox/a/1.json')).toBe(false);
    expect((await b.get('read/a/1.json')).toString()).toBe('payload');
    await expect(b.move('inbox/a/1.json', 'read/a/1.json')).rejects.toThrow(/key not found/);
  }, 60000);

  it('Bus semantics + claim: FIFO dequeue, archives under read/, null on empty', async () => {
    const { uri, cache } = await bareRemote();
    const bus = new Bus(await open(uri, cache));
    await bus.send({ from: 'p', to: 'work-queue', body: 'first' });
    await bus.send({ from: 'p', to: 'work-queue', body: 'second' });

    expect((await bus.claim('work-queue', 'w'))?.body).toBe('first');
    expect((await bus.claim('work-queue', 'w'))?.body).toBe('second');
    expect(await bus.claim('work-queue', 'w')).toBeNull();

    const backend = await open(uri, cache);
    expect((await backend.list('read/work-queue/')).length).toBe(2);
  }, 60000);

  it('claim CAS race: two INDEPENDENT instances (separate caches) split one queue disjointly', async () => {
    const { uri, cache } = await bareRemote();
    const producer = new Bus(await open(uri, cache));
    const N = 8;
    for (let i = 0; i < N; i++) await producer.send({ from: 'p', to: 'q', body: `task-${i}` });

    // Two consumers with their OWN cache clones — nothing shared but the remote.
    const c1 = new Bus(await open(uri, path.join(await mkTmp(), 'c1')));
    const c2 = new Bus(await open(uri, path.join(await mkTmp(), 'c2')));
    const drain = async (bus: Bus, owner: string): Promise<string[]> => {
      const got: string[] = [];
      for (;;) {
        const m = await bus.claim('q', owner);
        if (!m) return got;
        got.push(m.body);
      }
    };
    const [g1, g2] = await Promise.all([drain(c1, 'w1'), drain(c2, 'w2')]);
    const all = [...g1, ...g2].sort();
    expect(all).toEqual(Array.from({ length: N }, (_, i) => `task-${i}`).sort());
    expect(new Set(all).size).toBe(N); // disjoint — no double-delivery, none dropped
  }, 120000);

  it('?channel= isolates buses; ?branch= picks the bus branch; channels enumerates ?channel= URIs', async () => {
    const { uri, cache } = await bareRemote();
    const a = new Bus(await open(`${uri}?channel=team-a`, cache));
    const b = new Bus(await open(`${uri}?channel=team-b`, cache));
    await a.send({ from: 'alice', to: 'shared', body: 'for a' });
    expect(await b.inbox('shared')).toEqual([]);
    expect((await a.inbox('shared')).map((m) => m.body)).toEqual(['for a']);

    const other = new Bus(await open(`${uri}?branch=other-bus`, cache));
    await other.send({ from: 'x', to: 'y', body: 'elsewhere' });
    expect(await new Bus(await open(uri, cache)).inbox('y')).toEqual([]); // different branch entirely
  }, 60000);

  it('the CLI drives it end-to-end, and unknown params are rejected', async () => {
    const { uri, cache } = await bareRemote();
    const run = (args: string[]) =>
      new Promise<{ code: number; stdout: string; stderr: string }>((resolve, reject) => {
        const child = spawn(process.execPath, ['--import', tsx, cli, ...args], {
          stdio: ['ignore', 'pipe', 'pipe'],
          env: { ...process.env, AGENTCOMM_GIT_CACHE_DIR: cache },
        });
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (d) => (stdout += d.toString()));
        child.stderr.on('data', (d) => (stderr += d.toString()));
        child.on('error', reject);
        child.on('exit', (code) => resolve({ code: code ?? -1, stdout, stderr }));
      });

    expect((await run(['register', '--as', 'alice', '--backend', uri])).code).toBe(0);
    await run(['send', 'bob', 'over plain git', '--as', 'alice', '--backend', uri]);
    const inbox = await run(['inbox', '--as', 'bob', '--backend', uri, '--json']);
    expect((JSON.parse(inbox.stdout) as { body: string }[]).map((m) => m.body)).toEqual(['over plain git']);

    const bad = await run(['register', '--as', 'x', '--backend', `${uri}?chanel=a`]);
    expect(bad.code).toBe(1);
    expect(bad.stderr).toMatch(/unsupported query parameter/);
  }, 60000);

describe('commit messages are the feed', () => {
  it('statuses and sends read as a timeline in the bus branch history', async () => {
    const { uri, cache } = await bareRemote();
    const backend = await open(uri, cache);
    const bare = uri.replace('git+file://', '');
    try {
      await backend.put(
        'agents/worker-1.json',
        Buffer.from(JSON.stringify({ name: 'worker-1', registeredAt: 'x', lastSeen: 'x', status: 'reviewing PR 12' })),
      );
      await backend.put(
        'inbox/planner/00001-abc.json',
        Buffer.from(JSON.stringify({ id: 'abc', from: 'worker-1', to: 'planner', subject: 'done', body: 'shipped', ts: 'x' })),
      );
      const log = execFileSync('git', ['-C', bare, 'log', '--format=%s', 'agentcomm'], { encoding: 'utf8' });
      expect(log).toContain('agentcomm: worker-1 — reviewing PR 12');
      expect(log).toContain('agentcomm: worker-1 → planner [done]');
    } finally {
      await backend.close?.();
    }
  });
});
});
