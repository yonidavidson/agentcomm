import { describe, it, expect, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Bus } from '../src/bus.js';
import type { Backend } from '../src/types.js';
import { LocalBackend } from '../src/backends/local.js';
import { SqliteBackend } from '../src/backends/sqlite.js';

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

const factories: Record<string, () => Promise<Backend>> = {
  LocalBackend: async () => new LocalBackend(await mkTmp()),
  SqliteBackend: async () => SqliteBackend.open(path.join(await mkTmp(), 'bus.db')),
};

for (const [name, factory] of Object.entries(factories)) {
  describe(`Bus on ${name}`, () => {
    it('register is idempotent and preserves registeredAt', async () => {
      const bus = new Bus(await factory());
      const first = await bus.register('alice');
      await new Promise((r) => setTimeout(r, 5));
      const second = await bus.register('alice');
      expect(second.registeredAt).toBe(first.registeredAt);
      expect(second.lastSeen >= first.lastSeen).toBe(true);
      expect((await bus.agents()).map((a) => a.name)).toEqual(['alice']);
    });

    it('agents lists registered names sorted', async () => {
      const bus = new Bus(await factory());
      await bus.register('charlie');
      await bus.register('alice');
      await bus.register('bob');
      expect((await bus.agents()).map((a) => a.name)).toEqual(['alice', 'bob', 'charlie']);
    });

    it('send → inbox consumes and archives under read/', async () => {
      const backend = await factory();
      const bus = new Bus(backend);
      await bus.send({ from: 'alice', to: 'bob', body: 'hi' });
      const got = await bus.inbox('bob');
      expect(got).toHaveLength(1);
      expect(got[0]!.body).toBe('hi');
      expect(got[0]!.from).toBe('alice');
      // consumed: inbox now empty, archived under read/
      expect(await bus.inbox('bob')).toHaveLength(0);
      expect((await backend.list('read/bob/')).length).toBe(1);
    });

    it('messages return in send order', async () => {
      const bus = new Bus(await factory());
      for (const body of ['one', 'two', 'three']) {
        await bus.send({ from: 'alice', to: 'bob', body });
      }
      expect((await bus.inbox('bob')).map((m) => m.body)).toEqual(['one', 'two', 'three']);
    });

    it('peek does not consume', async () => {
      const bus = new Bus(await factory());
      await bus.send({ from: 'alice', to: 'bob', body: 'hi' });
      expect(await bus.peek('bob')).toHaveLength(1);
      expect(await bus.peek('bob')).toHaveLength(1); // still there
      expect(await bus.inbox('bob')).toHaveLength(1); // now consumed
    });

    it('broadcast reaches everyone but the sender', async () => {
      const bus = new Bus(await factory());
      await bus.register('alice');
      await bus.register('bob');
      await bus.register('carol');
      const sent = await bus.broadcast({ from: 'alice', body: 'all hands' });
      expect(sent.map((m) => m.to).sort()).toEqual(['bob', 'carol']);
      expect(await bus.inbox('alice')).toHaveLength(0);
      expect(await bus.inbox('bob')).toHaveLength(1);
    });

    it('wait returns immediately when a message is pending', async () => {
      const bus = new Bus(await factory());
      await bus.send({ from: 'alice', to: 'bob', body: 'hi' });
      const msgs = await bus.wait('bob', 1000);
      expect(msgs).toHaveLength(1);
    });

    it('wait returns [] on timeout', async () => {
      const bus = new Bus(await factory());
      const msgs = await bus.wait('bob', 120, 20);
      expect(msgs).toEqual([]);
    });

    it('wait wakes when a message arrives mid-poll', async () => {
      const bus = new Bus(await factory());
      const p = bus.wait('bob', 2000, 25);
      setTimeout(() => void bus.send({ from: 'alice', to: 'bob', body: 'late' }), 60);
      const msgs = await p;
      expect(msgs.map((m) => m.body)).toEqual(['late']);
    });

    it('subject and thread survive a round trip', async () => {
      const bus = new Bus(await factory());
      await bus.send({ from: 'alice', to: 'bob', body: 'x', subject: 'plan', thread: 't-1' });
      const [m] = await bus.inbox('bob');
      expect(m!.subject).toBe('plan');
      expect(m!.thread).toBe('t-1');
    });

    it('send/inbox/peek results carry no internal fields (e.g. _seq)', async () => {
      const bus = new Bus(await factory());
      const sent = await bus.send({ from: 'alice', to: 'bob', body: 'x' });
      expect(Object.keys(sent).sort()).toEqual(['body', 'from', 'id', 'to', 'ts']);
      const [peeked] = await bus.peek('bob');
      expect(Object.keys(peeked!).sort()).toEqual(['body', 'from', 'id', 'to', 'ts']);
      const [consumed] = await bus.inbox('bob');
      expect(Object.keys(consumed!).sort()).toEqual(['body', 'from', 'id', 'to', 'ts']);
    });

    if (name === 'SqliteBackend') {
      it('claim atomically dequeues the oldest message, FIFO, archives under read/', async () => {
        const backend = await factory();
        const bus = new Bus(backend);
        await bus.send({ from: 'alice', to: 'queue-a', body: 'first' });
        await bus.send({ from: 'alice', to: 'queue-a', body: 'second' });

        const first = await bus.claim('queue-a', 'worker-1');
        expect(first?.body).toBe('first');
        const second = await bus.claim('queue-a', 'worker-1');
        expect(second?.body).toBe('second');
        const empty = await bus.claim('queue-a', 'worker-1');
        expect(empty).toBeNull();

        expect((await backend.list('read/queue-a/')).length).toBe(2);
        expect((await backend.list('inbox/queue-a/')).length).toBe(0);
      });

      it('claim on an empty/unknown queue returns null, not an error', async () => {
        const bus = new Bus(await factory());
        expect(await bus.claim('nonexistent', 'worker-1')).toBeNull();
      });
    } else {
      it('claim throws a clear error on a non-Claimable backend', async () => {
        const bus = new Bus(await factory());
        await bus.send({ from: 'alice', to: 'queue-a', body: 'x' });
        await expect(bus.claim('queue-a', 'worker-1')).rejects.toThrow(/does not support claim/);
      });
    }
  });
}
