import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { GCSBackend } from '../src/backends/gcs.js';
import { Bus } from '../src/bus.js';

// Requires a GCS-compatible service — the compose stack runs fake-gcs-server.
// Spin it up with:
//   npm run test:e2e:up
// Self-skips when nothing is listening. Override the target with
// AGENTCOMM_TEST_GCS_ENDPOINT and AGENTCOMM_TEST_GCS_BUCKET.
const BUCKET = process.env.AGENTCOMM_TEST_GCS_BUCKET ?? 'agentcomm-test';
process.env.AGENTCOMM_GCS_API_ENDPOINT =
  process.env.AGENTCOMM_TEST_GCS_ENDPOINT ?? process.env.AGENTCOMM_GCS_API_ENDPOINT ?? 'http://127.0.0.1:4443';

let available = true;
try {
  const probe = await GCSBackend.open(BUCKET, `probe-${randomUUID()}`);
  await probe.list('');
} catch {
  available = false;
}
const maybeDescribe = available ? describe : describe.skip;
if (!available) {
  // eslint-disable-next-line no-console
  console.warn(
    `\nSkipping test/gcs.test.ts — no GCS service at ${process.env.AGENTCOMM_GCS_API_ENDPOINT} (bucket ${BUCKET}); run: npm run test:e2e:up\n`,
  );
}

// Every test gets its own base prefix inside the shared bucket, so tests are
// isolated without any truncation/cleanup step.
async function freshBackend(): Promise<GCSBackend> {
  return GCSBackend.open(BUCKET, `t-${randomUUID()}`);
}

maybeDescribe('GCSBackend (requires the docker-compose.test.yml stack)', () => {
  describe('Backend contract', () => {
    const buf = (s: string) => Buffer.from(s, 'utf8');

    it('put then get round-trips bytes', async () => {
      const b = await freshBackend();
      await b.put('inbox/a/1.json', buf('hello'));
      expect((await b.get('inbox/a/1.json')).toString()).toBe('hello');
    });

    it('put overwrites', async () => {
      const b = await freshBackend();
      await b.put('k', buf('one'));
      await b.put('k', buf('two'));
      expect((await b.get('k')).toString()).toBe('two');
    });

    it('get throws when absent', async () => {
      const b = await freshBackend();
      await expect(b.get('nope')).rejects.toThrow();
    });

    it('exists reflects presence', async () => {
      const b = await freshBackend();
      expect(await b.exists('k')).toBe(false);
      await b.put('k', buf('x'));
      expect(await b.exists('k')).toBe(true);
    });

    it('delete removes and is a no-op when absent', async () => {
      const b = await freshBackend();
      await b.put('k', buf('x'));
      await b.delete('k');
      expect(await b.exists('k')).toBe(false);
      await expect(b.delete('k')).resolves.toBeUndefined();
    });

    it('list returns prefix matches sorted ascending, without bleeding into sibling prefixes', async () => {
      const b = await freshBackend();
      await b.put('inbox/a/003.json', buf('3'));
      await b.put('inbox/a/001.json', buf('1'));
      await b.put('inbox/a/002.json', buf('2'));
      await b.put('inbox/ab/001.json', buf('x')); // 'inbox/a' is a prefix of 'inbox/ab'
      const keys = await b.list('inbox/a/');
      expect(keys).toEqual(['inbox/a/001.json', 'inbox/a/002.json', 'inbox/a/003.json']);
    });

    it('move relocates a key (copy+delete — documented as non-atomic)', async () => {
      const b = await freshBackend();
      await b.put('inbox/a/1.json', buf('payload'));
      await b.move('inbox/a/1.json', 'read/a/1.json');
      expect(await b.exists('inbox/a/1.json')).toBe(false);
      expect((await b.get('read/a/1.json')).toString()).toBe('payload');
    });
  });

  describe('Bus on GCSBackend', () => {
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
    });

    it('broadcast reaches everyone but the sender', async () => {
      const bus = new Bus(await freshBackend());
      await bus.register('alice');
      await bus.register('bob');
      await bus.register('carol');
      const sent = await bus.broadcast({ from: 'alice', body: 'all hands' });
      expect(sent.map((m) => m.to).sort()).toEqual(['bob', 'carol']);
    });

    it('claim is refused — object stores are single-consumer by design (move is not atomic)', async () => {
      const bus = new Bus(await freshBackend());
      await bus.send({ from: 'producer', to: 'work-queue', body: 'task' });
      await expect(bus.claim('work-queue', 'worker-1')).rejects.toThrow(/does not support claim/);
    });
  });

  describe('channel discovery on GCS', () => {
    it('two channels carved under one prefix are both found with agent counts', async () => {
      const { discoverChannels } = await import('../src/channels.js');
      const base = `disc-${randomUUID()}`;
      const teamA = new Bus(await GCSBackend.open(BUCKET, `${base}/team-a`));
      const teamB = new Bus(await GCSBackend.open(BUCKET, `${base}/team-b`));
      await teamA.register('alice');
      await teamA.register('bob');
      await teamB.send({ from: 'producer', to: 'builder', body: 'task' });

      const found = await discoverChannels(await GCSBackend.open(BUCKET, base));
      expect(found).toEqual([
        { prefix: 'team-a', agents: 2 },
        { prefix: 'team-b', agents: 0 },
      ]);
    });
  });
});
