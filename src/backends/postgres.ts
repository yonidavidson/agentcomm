import { type Backend, type Claimable, type Message, type Waitable } from '../types.js';
import { loadDriver } from './lazy.js';
import { upperBound } from './range.js';

/**
 * PostgresBackend — the distributed transport: implements {@link Backend} +
 * {@link Claimable} + {@link Waitable}, for the across-machines/containers
 * topology.
 *
 * Design choice (the digest leaves this open, documented here): a single
 * `blobs(key, data)` table backs EVERYTHING — Backend, Claimable, and
 * Waitable alike — exactly like SqliteBackend, rather than a separate
 * `messages` table with dedicated columns. Postgres's `SELECT ... FOR UPDATE
 * SKIP LOCKED` and `LISTEN/NOTIFY` work perfectly well directly against the
 * keyed blob table, so a parallel schema would only duplicate state for no
 * benefit. The tradeoff: claim ownership isn't persisted (same as SQLite) —
 * the returned Message is the only record of who has it.
 *
 * - `claim`: a transaction does `SELECT ... FOR UPDATE SKIP LOCKED LIMIT 1`
 *   on the `inbox/<queue>/` key range, then archives the row under
 *   `read/<queue>/`. Race-free across processes — SKIP LOCKED means
 *   concurrent claimers skip rows already locked by another in-flight claim
 *   instead of blocking on them.
 * - `waitPush`: `put()` issues `pg_notify(channel, '')` whenever the key is
 *   under `inbox/<recipient>/`; `waitPush` LISTENs on that channel and
 *   re-checks the inbox on every notification (and once immediately, to
 *   catch a message sent before LISTEN was issued), falling back to the
 *   timeout. One dedicated `pg.Client` per backend instance — LISTEN is
 *   connection-scoped, and Node's `pg` delivers NOTIFY as async events on
 *   that same connection regardless of other query activity on it.
 *
 * The `pg` driver is an OPTIONAL, LAZY-loaded dependency, same pattern as
 * every other backend.
 */
export class PostgresBackend implements Backend, Claimable, Waitable {
  private constructor(private readonly client: PgClientLike, private readonly pg: PgModule) {}

  static async open(connectionUri: string): Promise<PostgresBackend> {
    const pg = await loadDriver<PgModule>('pg', 'pg', 'the Postgres backend');
    const client = new pg.Client({ connectionString: connectionUri });
    await client.connect();
    await client.query('CREATE TABLE IF NOT EXISTS blobs (key TEXT PRIMARY KEY, data BYTEA NOT NULL)');
    return new PostgresBackend(client, pg);
  }

  async put(key: string, data: Buffer): Promise<void> {
    await this.client.query(
      'INSERT INTO blobs (key, data) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET data = excluded.data',
      [key, data],
    );
    const recipient = recipientOfInboxKey(key);
    if (recipient) {
      await this.client.query('SELECT pg_notify($1, $2)', [channelFor(recipient), '']);
    }
  }

  async get(key: string): Promise<Buffer> {
    const res = await this.client.query('SELECT data FROM blobs WHERE key = $1', [key]);
    const row = res.rows[0] as { data: Buffer } | undefined;
    if (!row) throw notFound(key);
    return toBuffer(row.data);
  }

  async list(prefix: string): Promise<string[]> {
    const upper = upperBound(prefix);
    const res =
      upper === null
        ? await this.client.query('SELECT key FROM blobs WHERE key >= $1 ORDER BY key', [prefix])
        : await this.client.query('SELECT key FROM blobs WHERE key >= $1 AND key < $2 ORDER BY key', [
            prefix,
            upper,
          ]);
    return (res.rows as { key: string }[]).map((r) => r.key);
  }

  async delete(key: string): Promise<void> {
    await this.client.query('DELETE FROM blobs WHERE key = $1', [key]);
  }

  async exists(key: string): Promise<boolean> {
    const res = await this.client.query('SELECT 1 FROM blobs WHERE key = $1', [key]);
    return res.rows.length > 0;
  }

  async move(src: string, dst: string): Promise<void> {
    await this.client.query('BEGIN');
    try {
      const res = await this.client.query('SELECT data FROM blobs WHERE key = $1 FOR UPDATE', [src]);
      const row = res.rows[0] as { data: Buffer } | undefined;
      if (!row) throw notFound(src);
      await this.client.query(
        'INSERT INTO blobs (key, data) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET data = excluded.data',
        [dst, row.data],
      );
      await this.client.query('DELETE FROM blobs WHERE key = $1', [src]);
      await this.client.query('COMMIT');
    } catch (err) {
      await this.client.query('ROLLBACK').catch(() => {});
      throw err;
    }
  }

  /** Atomically dequeue the oldest message in `inbox/<queue>/`. See class doc. */
  async claim(queue: string, _owner: string): Promise<Message | null> {
    const prefix = `inbox/${queue}/`;
    const upper = upperBound(prefix);
    await this.client.query('BEGIN');
    try {
      const res =
        upper === null
          ? await this.client.query(
              'SELECT key, data FROM blobs WHERE key >= $1 ORDER BY key FOR UPDATE SKIP LOCKED LIMIT 1',
              [prefix],
            )
          : await this.client.query(
              'SELECT key, data FROM blobs WHERE key >= $1 AND key < $2 ORDER BY key FOR UPDATE SKIP LOCKED LIMIT 1',
              [prefix, upper],
            );
      const row = res.rows[0] as { key: string; data: Buffer } | undefined;
      if (!row) {
        await this.client.query('COMMIT');
        return null;
      }
      const dst = 'read/' + row.key.slice('inbox/'.length);
      await this.client.query(
        'INSERT INTO blobs (key, data) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET data = excluded.data',
        [dst, row.data],
      );
      await this.client.query('DELETE FROM blobs WHERE key = $1', [row.key]);
      await this.client.query('COMMIT');
      return JSON.parse(toBuffer(row.data).toString('utf8')) as Message;
    } catch (err) {
      await this.client.query('ROLLBACK').catch(() => {});
      throw err;
    }
  }

  /** Push-driven wait: LISTEN on the recipient's channel, NOTIFY'd by put(). See class doc. */
  async waitPush(recipient: string, timeoutMs: number): Promise<Message[]> {
    const channel = channelFor(recipient);
    await this.client.query(`LISTEN ${this.pg.escapeIdentifier(channel)}`);

    const prefix = `inbox/${recipient}/`;
    let pending = await this.listMessages(prefix);
    if (pending.length > 0) return pending;

    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const notified = await waitForNotification(this.client, channel, deadline - Date.now());
      pending = await this.listMessages(prefix);
      if (pending.length > 0) return pending;
      if (!notified) break;
    }
    return [];
  }

  private async listMessages(prefix: string): Promise<Message[]> {
    const keys = await this.list(prefix);
    const out: Message[] = [];
    for (const key of keys) {
      if (!key.endsWith('.json')) continue;
      try {
        out.push(JSON.parse((await this.get(key)).toString('utf8')) as Message);
      } catch {
        continue;
      }
    }
    return out;
  }

  async close(): Promise<void> {
    await this.client.end();
  }
}

function notFound(key: string): NodeJS.ErrnoException {
  const err = new Error(`agentcomm: key not found: ${key}`) as NodeJS.ErrnoException;
  err.code = 'ENOENT';
  return err;
}

function recipientOfInboxKey(key: string): string | null {
  const m = /^inbox\/([^/]+)\//.exec(key);
  return m ? m[1]! : null;
}

function channelFor(recipient: string): string {
  return `agentcomm_${recipient}`;
}

function toBuffer(data: Buffer | Uint8Array): Buffer {
  return Buffer.isBuffer(data) ? data : Buffer.from(data);
}

/** Resolve once a NOTIFY for `channel` arrives, or `ms` elapses (false). */
function waitForNotification(client: PgClientLike, channel: string, ms: number): Promise<boolean> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (result: boolean) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      client.removeListener('notification', onNotify);
      resolve(result);
    };
    const onNotify = (msg: { channel: string }) => {
      if (msg.channel === channel) finish(true);
    };
    const timer = setTimeout(() => finish(false), Math.max(0, ms));
    client.on('notification', onNotify);
  });
}

// Minimal structural types for the lazily-imported driver, so we don't take a
// hard type dependency on @types/pg at the call sites above.
interface PgQueryResult<T = unknown> {
  rows: T[];
}
interface PgClientLike {
  connect(): Promise<void>;
  query(sql: string, params?: unknown[]): Promise<PgQueryResult>;
  end(): Promise<void>;
  on(event: 'notification', listener: (msg: { channel: string; payload?: string }) => void): void;
  removeListener(
    event: 'notification',
    listener: (msg: { channel: string; payload?: string }) => void,
  ): void;
}
interface PgModule {
  Client: new (config: { connectionString: string }) => PgClientLike;
  escapeIdentifier(str: string): string;
}
