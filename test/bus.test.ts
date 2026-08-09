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

describe('status precedence: explicit wins while fresh, task refreshes when stale', () => {
  it('a fresh explicit status blocks task auto-status; a stale one yields', async () => {
    const backend = new LocalBackend(await mkTmp());
    const bus = new Bus(backend);

    // explicit declaration (statusAuto=false), fresh
    await bus.register('dev', 'sess', 'narrative: shipping the thing', false);
    // an auto (task) status must NOT overwrite the fresh explicit one
    await bus.register('dev', 'sess', 'terse task', true);
    let rec = (await bus.agents()).find((a) => a.name === 'dev')!;
    expect(rec.status).toBe('narrative: shipping the thing');

    // backdate the explicit status past the sticky window
    const key = `agents/dev.json`;
    const raw = JSON.parse((await backend.get(key)).toString('utf8'));
    raw.statusAt = '2020-01-01T00:00:00.000Z';
    await backend.put(key, Buffer.from(JSON.stringify(raw)));

    // now a task refreshes it — the board can't freeze on old work
    await bus.register('dev', 'sess', 'the new task', true);
    rec = (await bus.agents()).find((a) => a.name === 'dev')!;
    expect(rec.status).toBe('the new task');

    // and an explicit re-declaration always wins immediately
    await bus.register('dev', 'sess', 'fresh narrative again', false);
    await bus.register('dev', 'sess', 'another task', true);
    rec = (await bus.agents()).find((a) => a.name === 'dev')!;
    expect(rec.status).toBe('fresh narrative again');

    await backend.close?.();
  });
});

/**
 * Delivery before consumption (issue #158). Archiving as we read meant an
 * `inbox` that died mid-flight — a harness timeout, a Ctrl-C — left messages
 * consumed AND undelivered. These pin the order, and the failure mode when
 * the archive step is the thing that breaks.
 */
describe('inbox delivers before it consumes (issue #158)', () => {
  /** A backend that records op order and can be told to fail every move. */
  class Recording implements Backend {
    readonly ops: string[] = [];
    breakMove = false;
    constructor(private readonly inner: Backend) {}
    put(key: string, data: Buffer): Promise<void> {
      return this.inner.put(key, data);
    }
    get(key: string): Promise<Buffer> {
      return this.inner.get(key);
    }
    list(prefix: string): Promise<string[]> {
      return this.inner.list(prefix);
    }
    delete(key: string): Promise<void> {
      return this.inner.delete(key);
    }
    exists(key: string): Promise<boolean> {
      return this.inner.exists(key);
    }
    async move(src: string, dst: string): Promise<void> {
      this.ops.push(`move ${src}`);
      if (this.breakMove) throw new Error('store went away');
      return this.inner.move(src, dst);
    }
  }

  const busWith = async (): Promise<{ bus: Bus; backend: Recording }> => {
    const backend = new Recording(new LocalBackend(await mkTmp()));
    const bus = new Bus(backend);
    for (const body of ['one', 'two']) await bus.send({ from: 'alice', to: 'bob', body });
    return { bus, backend };
  };

  it('hands every message to the caller before archiving any of them', async () => {
    const { bus, backend } = await busWith();
    const got = await bus.inbox('bob', {
      deliver: (messages) => {
        backend.ops.push(`deliver ${messages.length}`);
      },
    });
    expect(got.map((m) => m.body)).toEqual(['one', 'two']);
    expect(backend.ops[0]).toBe('deliver 2');
    expect(backend.ops.filter((o) => o.startsWith('move'))).toHaveLength(2);
  });

  it('a delivery that throws consumes nothing — the mail is still there', async () => {
    const { bus, backend } = await busWith();
    await expect(
      bus.inbox('bob', {
        deliver: () => {
          throw new Error('pipe closed');
        },
      }),
    ).rejects.toThrow(/pipe closed/);
    expect(backend.ops).toHaveLength(0);
    expect((await bus.peek('bob')).map((m) => m.body)).toEqual(['one', 'two']);
  });

  it('an archive that fails re-delivers rather than losing: reported, still pending', async () => {
    const { bus, backend } = await busWith();
    backend.breakMove = true;
    const unarchived: string[] = [];
    const got = await bus.inbox('bob', { onUnarchived: (keys) => unarchived.push(...keys) });
    expect(got.map((m) => m.body)).toEqual(['one', 'two']);
    expect(unarchived).toHaveLength(2);
    expect((await bus.peek('bob')).map((m) => m.body)).toEqual(['one', 'two']);
  });
});

/**
 * Archiving a consumed mailbox is ONE store operation where the backend can
 * do it (issue #159) — key-by-key it was a network round trip per message,
 * which is what made `inbox` time out on a remote bus.
 */
describe('archive batches when the backend can (issue #159)', () => {
  it('uses moveMany once, and falls back to per-key moves when the batch fails', async () => {
    const inner = new LocalBackend(await mkTmp());
    let batches = 0;
    let singles = 0;
    let breakBatch = false;
    const backend: Backend & { moveMany(m: { src: string; dst: string }[]): Promise<void> } = {
      put: (k, d) => inner.put(k, d),
      get: (k) => inner.get(k),
      list: (p) => inner.list(p),
      delete: (k) => inner.delete(k),
      exists: (k) => inner.exists(k),
      move: (s, d) => {
        singles++;
        return inner.move(s, d);
      },
      moveMany: async (moves) => {
        batches++;
        if (breakBatch) throw new Error('batch rejected');
        for (const { src, dst } of moves) await inner.move(src, dst);
      },
    };
    const bus = new Bus(backend);
    for (const body of ['a', 'b', 'c']) await bus.send({ from: 'x', to: 'bob', body });

    expect(await bus.inbox('bob')).toHaveLength(3);
    expect(batches).toBe(1);
    expect(singles).toBe(0);

    breakBatch = true;
    for (const body of ['d', 'e']) await bus.send({ from: 'x', to: 'bob', body });
    expect(await bus.inbox('bob')).toHaveLength(2);
    expect(singles).toBe(2); // batch refused → each message still archived
    expect((await inner.list('inbox/bob/')).length).toBe(0);
  });
});

/**
 * Read and clear were the same operation (issue #160): `peek` shows without
 * consuming, `inbox` consumes what it shows, and nothing cleared mail read
 * any other way — so an agent that had read and answered every message still
 * showed N unread forever.
 */
describe('ack clears mail already read (issue #160)', () => {
  it('acks by id without re-fetching bodies, and reports ids that are not pending', async () => {
    const backend = new LocalBackend(await mkTmp());
    const bus = new Bus(backend);
    const one = await bus.send({ from: 'alice', to: 'bob', body: 'one' });
    const two = await bus.send({ from: 'alice', to: 'bob', body: 'two' });
    await bus.send({ from: 'alice', to: 'bob', body: 'three' });

    expect(await bus.peek('bob')).toHaveLength(3); // read, non-destructively

    const acked = await bus.ack('bob', [one.id, two.id, 'not-a-real-id']);
    expect(acked.acked.sort()).toEqual([one.id, two.id].sort());
    expect(acked.unknown).toEqual(['not-a-real-id']);
    expect(acked.failed).toEqual([]);

    expect((await bus.peek('bob')).map((m) => m.body)).toEqual(['three']);
    expect((await backend.list('read/bob/')).length).toBe(2); // archived, not deleted
  });

  it('--all clears the whole mailbox; acking an empty one is a no-op', async () => {
    const bus = new Bus(new LocalBackend(await mkTmp()));
    for (const body of ['a', 'b']) await bus.send({ from: 'alice', to: 'bob', body });
    expect((await bus.ack('bob', 'all')).acked).toHaveLength(2);
    expect(await bus.peek('bob')).toHaveLength(0);
    expect(await bus.ack('bob', 'all')).toEqual({ acked: [], unknown: [], failed: [] });
  });

  it('one agent cannot ack another agent mailbox message', async () => {
    const bus = new Bus(new LocalBackend(await mkTmp()));
    const mine = await bus.send({ from: 'alice', to: 'bob', body: 'for bob' });
    const result = await bus.ack('carol', [mine.id]);
    expect(result.unknown).toEqual([mine.id]);
    expect(await bus.peek('bob')).toHaveLength(1);
  });
});

/**
 * `sent` has only ever meant QUEUED (issue #162). These cover the two facts
 * that make "and someone read it" answerable: a per-recipient unread depth,
 * and when each agent last consumed its mailbox.
 */
describe('delivery visibility (issue #162)', () => {
  it('counts unread per recipient, including mailboxes nobody registered', async () => {
    const bus = new Bus(new LocalBackend(await mkTmp()));
    await bus.register('bob');
    await bus.send({ from: 'alice', to: 'bob', body: '1' });
    await bus.send({ from: 'alice', to: 'bob', body: '2' });
    await bus.send({ from: 'alice', to: 'ghost', body: 'nobody home' });

    expect(await bus.unreadCounts()).toEqual({ bob: 2, ghost: 1 });
    expect(await bus.unread('bob')).toBe(2);
    expect(await bus.unread('nobody')).toBe(0);
  });

  it('markRead stamps lastRead, and a heartbeat preserves it', async () => {
    const bus = new Bus(new LocalBackend(await mkTmp()));
    await bus.register('bob', 'sess');
    expect((await bus.agents())[0]!.lastRead).toBeUndefined();

    await bus.markRead('bob');
    const read = (await bus.agents())[0]!.lastRead;
    expect(read).toBeTruthy();

    await bus.register('bob', 'sess'); // heartbeat must not erase the read stamp
    expect((await bus.agents())[0]!.lastRead).toBe(read);
  });

  it('markRead never conjures a registration — a one-off read leaves no ghost', async () => {
    const bus = new Bus(new LocalBackend(await mkTmp()));
    await bus.markRead('walk-in');
    // registrations are never purged; a `inbox --as someone` must not create
    // a permanent roster entry
    expect(await bus.agents()).toEqual([]);
  });
});
