import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { S3Backend } from '../src/backends/s3.js';
import { Bus } from '../src/bus.js';

// Requires an S3-compatible service — the compose stack runs Garage (Rust).
// Spin it up with:
//   npm run test:e2e:up
// Self-skips when nothing is listening. Point at a different service with
// AGENTCOMM_TEST_S3_ENDPOINT (+ the standard AWS_* env vars for credentials)
// and AGENTCOMM_TEST_S3_BUCKET.
const BUCKET = process.env.AGENTCOMM_TEST_S3_BUCKET ?? 'agentcomm-test';
const CUSTOM_ENDPOINT = process.env.AGENTCOMM_TEST_S3_ENDPOINT;
if (CUSTOM_ENDPOINT) {
  process.env.AWS_ENDPOINT_URL_S3 = CUSTOM_ENDPOINT;
} else {
  // Default: the local compose stack, with the fixed throwaway credentials
  // provisioned by test/e2e/setup.sh.
  process.env.AWS_ENDPOINT_URL_S3 = 'http://127.0.0.1:3900';
  process.env.AWS_ACCESS_KEY_ID = 'GK31c2f218a2e44f485b94239e';
  process.env.AWS_SECRET_ACCESS_KEY = '0f2b5f2e1c4a4d5e8a7b6c9d0e1f2a3b4c5d6e7f8091a2b3c4d5e6f708192a3b';
  process.env.AWS_REGION = 'garage';
}
process.env.AGENTCOMM_S3_FORCE_PATH_STYLE ??= '1';
process.env.AWS_MAX_ATTEMPTS ??= '2'; // fail the probe fast when nothing is listening

let available = true;
try {
  const probe = await S3Backend.open(BUCKET, `probe-${randomUUID()}`);
  await probe.list('');
} catch {
  available = false;
}
const maybeDescribe = available ? describe : describe.skip;
if (!available) {
  // eslint-disable-next-line no-console
  console.warn(
    `\nSkipping test/s3.test.ts — no S3 service at ${process.env.AWS_ENDPOINT_URL_S3} (bucket ${BUCKET}); run: npm run test:e2e:up\n`,
  );
}

// Every test gets its own base prefix inside the shared bucket, so tests are
// isolated without any truncation/cleanup step.
async function freshBackend(): Promise<S3Backend> {
  return S3Backend.open(BUCKET, `t-${randomUUID()}`);
}

maybeDescribe('S3Backend (requires the docker-compose.test.yml stack)', () => {
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

  describe('Bus on S3Backend', () => {
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
});
