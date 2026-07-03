import { describe, it, expect, beforeEach } from 'vitest';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import pg from 'pg';
import { PostgresBackend } from '../src/backends/postgres.js';
import { Bus } from '../src/bus.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const cli = path.join(here, '..', 'src', 'cli.ts');
const claimWorker = path.join(here, 'helpers', 'postgres-claim-worker.ts');

const PG_URL = process.env.AGENTCOMM_TEST_POSTGRES_URL ?? 'postgresql://postgres:test@localhost:55432/agentcomm';

// Requires a real Postgres reachable at PG_URL — see README "Development".
// Spin one up locally with:
//   docker run -d --name agentcomm-pg-test -e POSTGRES_PASSWORD=test \
//     -e POSTGRES_DB=agentcomm -p 55432:5432 postgres:16-alpine
let available = true;
try {
  const probe = await PostgresBackend.open(PG_URL);
  await probe.close();
} catch {
  available = false;
}
const maybeDescribe = available ? describe : describe.skip;
if (!available) {
  // eslint-disable-next-line no-console
  console.warn(`\nSkipping test/postgres.test.ts — no Postgres reachable at ${PG_URL}\n`);
}

async function freshBackend(): Promise<PostgresBackend> {
  const backend = await PostgresBackend.open(PG_URL);
  return backend;
}

maybeDescribe('PostgresBackend (requires Docker Postgres)', () => {
  beforeEach(async () => {
    // Truncate via a raw client — there's no Backend.clear(), and this is the
    // simplest way to give every test a blank table without per-test key
    // namespacing on a single shared database. Uses its own connection
    // rather than reaching into PostgresBackend's internals.
    const client = new pg.Client({ connectionString: PG_URL });
    await client.connect();
    await client.query('CREATE TABLE IF NOT EXISTS blobs (key TEXT PRIMARY KEY, data BYTEA NOT NULL)');
    await client.query('TRUNCATE TABLE blobs');
    await client.end();
  });

  describe('Backend contract', () => {
    const buf = (s: string) => Buffer.from(s, 'utf8');

    it('put then get round-trips bytes', async () => {
      const b = await freshBackend();
      await b.put('inbox/a/1.json', buf('hello'));
      expect((await b.get('inbox/a/1.json')).toString()).toBe('hello');
      await b.close();
    });

    it('put overwrites', async () => {
      const b = await freshBackend();
      await b.put('k', buf('one'));
      await b.put('k', buf('two'));
      expect((await b.get('k')).toString()).toBe('two');
      await b.close();
    });

    it('get throws when absent', async () => {
      const b = await freshBackend();
      await expect(b.get('nope')).rejects.toThrow();
      await b.close();
    });

    it('exists reflects presence', async () => {
      const b = await freshBackend();
      expect(await b.exists('k')).toBe(false);
      await b.put('k', buf('x'));
      expect(await b.exists('k')).toBe(true);
      await b.close();
    });

    it('delete removes and is a no-op when absent', async () => {
      const b = await freshBackend();
      await b.put('k', buf('x'));
      await b.delete('k');
      expect(await b.exists('k')).toBe(false);
      await expect(b.delete('k')).resolves.toBeUndefined();
      await b.close();
    });

    it('list returns prefix matches sorted ascending, without bleeding into sibling prefixes', async () => {
      const b = await freshBackend();
      await b.put('inbox/a/003.json', buf('3'));
      await b.put('inbox/a/001.json', buf('1'));
      await b.put('inbox/a/002.json', buf('2'));
      await b.put('inbox/ab/001.json', buf('x')); // 'inbox/a' is a prefix of 'inbox/ab'
      const keys = await b.list('inbox/a/');
      expect(keys).toEqual(['inbox/a/001.json', 'inbox/a/002.json', 'inbox/a/003.json']);
      await b.close();
    });

    it('move relocates a key atomically', async () => {
      const b = await freshBackend();
      await b.put('inbox/a/1.json', buf('payload'));
      await b.move('inbox/a/1.json', 'read/a/1.json');
      expect(await b.exists('inbox/a/1.json')).toBe(false);
      expect((await b.get('read/a/1.json')).toString()).toBe('payload');
      await b.close();
    });
  });

  describe('Bus on PostgresBackend', () => {
    it('send → inbox round-trips in send order and archives under read/', async () => {
      const backend = await freshBackend();
      const bus = new Bus(backend);
      for (const body of ['one', 'two', 'three']) {
        await bus.send({ from: 'alice', to: 'bob', body });
      }
      const got = await bus.inbox('bob');
      expect(got.map((m) => m.body)).toEqual(['one', 'two', 'three']);
      expect(await bus.inbox('bob')).toHaveLength(0);
      expect((await backend.list('read/bob/')).length).toBe(3);
      await backend.close();
    });

    it('broadcast reaches everyone but the sender', async () => {
      const backend = await freshBackend();
      const bus = new Bus(backend);
      await bus.register('alice');
      await bus.register('bob');
      await bus.register('carol');
      const sent = await bus.broadcast({ from: 'alice', body: 'all hands' });
      expect(sent.map((m) => m.to).sort()).toEqual(['bob', 'carol']);
      await backend.close();
    });
  });

  describe('Claimable', () => {
    it('claim atomically dequeues the oldest message, FIFO, archives under read/', async () => {
      const backend = await freshBackend();
      const bus = new Bus(backend);
      await bus.send({ from: 'producer', to: 'work-queue', body: 'first' });
      await bus.send({ from: 'producer', to: 'work-queue', body: 'second' });

      expect((await bus.claim('work-queue', 'worker-1'))?.body).toBe('first');
      expect((await bus.claim('work-queue', 'worker-1'))?.body).toBe('second');
      expect(await bus.claim('work-queue', 'worker-1')).toBeNull();

      expect((await backend.list('read/work-queue/')).length).toBe(2);
      expect((await backend.list('inbox/work-queue/')).length).toBe(0);
      await backend.close();
    });

    it(
      'N concurrent worker processes claiming from one shared queue get disjoint messages, none dropped, none double-delivered',
      async () => {
        const N_MESSAGES = 100;
        const N_WORKERS = 6;
        const queue = `work-queue-${randomUUID().slice(0, 8)}`;

        const backend = await freshBackend();
        const bus = new Bus(backend);
        for (let i = 0; i < N_MESSAGES; i++) {
          await bus.send({ from: 'producer', to: queue, body: `task-${i}`, subject: String(i) });
        }
        await backend.close();

        const claimedByWorker = await Promise.all(
          Array.from({ length: N_WORKERS }, (_, i) => runClaimWorker(queue, `worker-${i}`)),
        );
        const allClaimed = claimedByWorker.flat();
        expect(allClaimed).toHaveLength(N_MESSAGES);
        expect(new Set(allClaimed).size).toBe(N_MESSAGES);

        const finalBackend = await freshBackend();
        expect(await new Bus(finalBackend).claim(queue, 'late-worker')).toBeNull();
        await finalBackend.close();
      },
      30000,
    );
  });

  describe('Waitable (push)', () => {
    it('wait returns immediately when a message is already pending', async () => {
      const backend = await freshBackend();
      const bus = new Bus(backend);
      await bus.send({ from: 'alice', to: 'bob', body: 'already here' });
      const t0 = Date.now();
      const msgs = await bus.wait('bob', 5000);
      expect(Date.now() - t0).toBeLessThan(500);
      expect(msgs.map((m) => m.body)).toEqual(['already here']);
      await backend.close();
    });

    it('wait returns [] at the deadline on timeout', async () => {
      const backend = await freshBackend();
      const bus = new Bus(backend);
      const t0 = Date.now();
      const msgs = await bus.wait('nobody', 500);
      const elapsed = Date.now() - t0;
      expect(msgs).toEqual([]);
      expect(elapsed).toBeGreaterThanOrEqual(450);
      expect(elapsed).toBeLessThan(2000);
      await backend.close();
    });

    it('wait is push-driven: resolves shortly after a send from a separate connection, not on a poll interval', async () => {
      const waiterBackend = await freshBackend();
      const waiterBus = new Bus(waiterBackend);

      const t0 = Date.now();
      const waitPromise = waiterBus.wait('pushtest', 5000);

      const senderReady = (async () => {
        await new Promise((r) => setTimeout(r, 300));
        const senderBackend = await freshBackend();
        await new Bus(senderBackend).send({ from: 'alice', to: 'pushtest', body: 'pushed' });
        await senderBackend.close();
      })();

      const [msgs] = await Promise.all([waitPromise, senderReady]);
      const elapsed = Date.now() - t0;
      expect(msgs.map((m) => m.body)).toEqual(['pushed']);
      // Generous upper bound — a poll loop's default interval (250ms) stacked
      // on the 300ms send delay would push this past 550ms; push delivery
      // should land within tens of ms of the send.
      expect(elapsed).toBeLessThan(500);

      await waiterBackend.close();
    });

    it(
      'wait is push-driven across real OS processes (CLI subprocess send while another CLI subprocess waits)',
      async () => {
        // Generous process-level timeouts: on a cold CI runner, tsx boot for
        // each child takes seconds. The latency assertion below is measured
        // from the moment the send process EXITS (send committed), so child
        // startup time never counts against it — this test proves delivery
        // across real processes; the tight push-latency bound is the
        // in-process test above.
        const waitChild = spawn(
          process.execPath,
          ['--import', 'tsx', cli, 'wait', '--as', 'cross-process-bob', '--backend', PG_URL, '--timeout', '30000'],
          { stdio: ['ignore', 'pipe', 'pipe'] },
        );
        let stdout = '';
        waitChild.stdout.on('data', (d) => (stdout += d.toString()));

        await new Promise((r) => setTimeout(r, 400));
        await new Promise<void>((resolve, reject) => {
          const sendChild = spawn(
            process.execPath,
            ['--import', 'tsx', cli, 'send', 'cross-process-bob', 'cross process push', '--as', 'alice', '--backend', PG_URL],
            { stdio: 'ignore' },
          );
          sendChild.on('error', reject);
          sendChild.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`send exited ${code}`))));
        });
        const t0 = Date.now();

        const exitCode = await new Promise<number>((resolve) => {
          waitChild.on('exit', (code) => resolve(code ?? -1));
        });
        const elapsed = Date.now() - t0;

        expect(exitCode).toBe(0);
        expect(stdout).toContain('cross process push');
        // Far under the waiter's own 30s timeout: proves the waiter was
        // released by the send, not by running out its clock.
        expect(elapsed).toBeLessThan(3000);
      },
      60000,
    );
  });

  describe('Connection errors', () => {
    it('opening with an unreachable Postgres surfaces a clear, rejected error (not a hang)', async () => {
      await expect(PostgresBackend.open('postgresql://postgres:test@localhost:1/agentcomm')).rejects.toThrow();
    }, 10000);
  });
});

function runClaimWorker(queue: string, owner: string): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', claimWorker, PG_URL, queue, owner], {
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
        : reject(new Error(`postgres-claim-worker exited ${code}: ${stderr}`)),
    );
  });
}
