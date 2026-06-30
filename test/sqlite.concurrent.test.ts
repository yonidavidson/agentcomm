import { describe, it, expect, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { SqliteBackend } from '../src/backends/sqlite.js';
import { Bus } from '../src/bus.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const worker = path.join(here, 'helpers', 'append-worker.ts');
const claimWorker = path.join(here, 'helpers', 'claim-worker.ts');

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

function runWorker(db: string, from: string, to: string, count: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ['--import', 'tsx', worker, db, from, to, String(count)],
      { stdio: ['ignore', 'ignore', 'pipe'] },
    );
    let stderr = '';
    child.stderr.on('data', (d) => (stderr += d.toString()));
    child.on('error', reject);
    child.on('exit', (code) =>
      code === 0 ? resolve() : reject(new Error(`worker exited ${code}: ${stderr}`)),
    );
  });
}

function runClaimWorker(db: string, queue: string, owner: string): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', claimWorker, db, queue, owner], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d.toString()));
    child.stderr.on('data', (d) => (stderr += d.toString()));
    child.on('error', reject);
    child.on('exit', (code) =>
      code === 0
        ? resolve(stdout.split('\n').filter(Boolean))
        : reject(new Error(`claim-worker exited ${code}: ${stderr}`)),
    );
  });
}

describe('SqliteBackend concurrency (WAL)', () => {
  it('two processes appending to different inboxes both succeed', async () => {
    const db = path.join(await mkTmp(), 'bus.db');
    const N = 50;
    // Initialize the db/schema before the workers race on it.
    await (await SqliteBackend.open(db)).close();

    await Promise.all([
      runWorker(db, 'alice', 'inboxA', N),
      runWorker(db, 'bob', 'inboxB', N),
    ]);

    const bus = new Bus(await SqliteBackend.open(db));
    const a = await bus.inbox('inboxA');
    const b = await bus.inbox('inboxB');
    expect(a).toHaveLength(N);
    expect(b).toHaveLength(N);
    // each inbox received exactly its own sender's messages, in order
    expect(a.every((m) => m.from === 'alice')).toBe(true);
    expect(b.every((m) => m.from === 'bob')).toBe(true);
    expect(a.map((m) => m.subject)).toEqual(Array.from({ length: N }, (_, i) => String(i)));
  }, 30000);

  it('N concurrent workers claiming from one shared queue get disjoint messages, none dropped, none double-delivered', async () => {
    const db = path.join(await mkTmp(), 'bus.db');
    const N_MESSAGES = 120;
    const N_WORKERS = 6;

    const backend = await SqliteBackend.open(db);
    const bus = new Bus(backend);
    for (let i = 0; i < N_MESSAGES; i++) {
      await bus.send({ from: 'producer', to: 'work-queue', body: `task-${i}`, subject: String(i) });
    }
    await backend.close();

    const claimedByWorker = await Promise.all(
      Array.from({ length: N_WORKERS }, (_, i) => runClaimWorker(db, 'work-queue', `worker-${i}`)),
    );

    const allClaimed = claimedByWorker.flat();
    // none dropped, none double-delivered: every id claimed exactly once
    expect(allClaimed).toHaveLength(N_MESSAGES);
    expect(new Set(allClaimed).size).toBe(N_MESSAGES);
    // queue is fully drained
    const finalBus = new Bus(await SqliteBackend.open(db));
    expect(await finalBus.claim('work-queue', 'late-worker')).toBeNull();
  }, 30000);
});
