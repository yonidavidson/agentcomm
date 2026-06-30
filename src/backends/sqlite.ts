import { type Backend } from '../types.js';
import { loadDriver } from './lazy.js';

/**
 * SqliteBackend — a faithful blob implementation of {@link Backend} backed by
 * a single SQLite database file in WAL mode. This is the recommended default
 * for the single-machine topology: no daemon, ACID, atomic per-key writes and
 * atomic `move` via a transaction.
 *
 * The `better-sqlite3` driver is an OPTIONAL, LAZY-loaded dependency — exactly
 * like the s3/gcs backends — so the local filesystem backend stays
 * zero-dependency. A missing driver produces a clear "install it" error.
 *
 * NOTE: never place the database file on object storage (S3/GCS/gcsfuse).
 * SQLite needs a real filesystem with byte-range locks; over object storage
 * its locking guarantees break and concurrent writes corrupt the file.
 */
export class SqliteBackend implements Backend {
  private constructor(private readonly db: BetterSqlite3Database) {}

  /**
   * Open (or create) the database at `filePath` and prepare the schema.
   * Lazy-imports better-sqlite3; throws {@link MissingDriverError} if absent.
   */
  static async open(filePath: string): Promise<SqliteBackend> {
    // Lazy, optional import. Resolved only when a sqlite:// URI is used.
    const mod = await loadDriver<{ default: BetterSqlite3Constructor }>(
      'better-sqlite3',
      'better-sqlite3',
      'the SQLite backend',
    );
    const Database = mod.default;

    const db = new Database(filePath);
    // WAL gives concurrent readers + a single writer without a daemon.
    db.pragma('journal_mode = WAL');
    db.pragma('busy_timeout = 5000');
    db.pragma('synchronous = NORMAL');
    db.exec('CREATE TABLE IF NOT EXISTS blobs (key TEXT PRIMARY KEY, data BLOB NOT NULL)');

    return new SqliteBackend(db);
  }

  async put(key: string, data: Buffer): Promise<void> {
    this.db
      .prepare('INSERT INTO blobs (key, data) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET data = excluded.data')
      .run(key, data);
    return Promise.resolve();
  }

  async get(key: string): Promise<Buffer> {
    const row = this.db.prepare('SELECT data FROM blobs WHERE key = ?').get(key) as
      | { data: Buffer }
      | undefined;
    if (!row) {
      const err = new Error(`agentcomm: key not found: ${key}`) as NodeJS.ErrnoException;
      err.code = 'ENOENT';
      throw err;
    }
    return Promise.resolve(toBuffer(row.data));
  }

  async list(prefix: string): Promise<string[]> {
    // Range scan so the PRIMARY KEY index is used (no full scan, no LIKE).
    // Upper bound = prefix with its last byte incremented.
    const upper = upperBound(prefix);
    const rows =
      upper === null
        ? (this.db.prepare('SELECT key FROM blobs WHERE key >= ? ORDER BY key').all(prefix) as {
            key: string;
          }[])
        : (this.db
            .prepare('SELECT key FROM blobs WHERE key >= ? AND key < ? ORDER BY key')
            .all(prefix, upper) as { key: string }[]);
    return Promise.resolve(rows.map((r) => r.key));
  }

  async delete(key: string): Promise<void> {
    this.db.prepare('DELETE FROM blobs WHERE key = ?').run(key);
    return Promise.resolve();
  }

  async exists(key: string): Promise<boolean> {
    const row = this.db.prepare('SELECT 1 FROM blobs WHERE key = ?').get(key);
    return Promise.resolve(row !== undefined);
  }

  async move(src: string, dst: string): Promise<void> {
    // One transaction: copy src -> dst, drop src. Atomic.
    const tx = this.db.transaction((from: string, to: string) => {
      const row = this.db.prepare('SELECT data FROM blobs WHERE key = ?').get(from) as
        | { data: Buffer }
        | undefined;
      if (!row) {
        const err = new Error(`agentcomm: key not found: ${from}`) as NodeJS.ErrnoException;
        err.code = 'ENOENT';
        throw err;
      }
      this.db
        .prepare('INSERT INTO blobs (key, data) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET data = excluded.data')
        .run(to, row.data);
      this.db.prepare('DELETE FROM blobs WHERE key = ?').run(from);
    });
    tx(src, dst);
    return Promise.resolve();
  }

  async close(): Promise<void> {
    this.db.close();
    return Promise.resolve();
  }
}

/**
 * Smallest key that is strictly greater than every key with `prefix`.
 * Increments the last byte; returns null if the prefix is empty or all 0xff
 * (in which case there is no upper bound and the caller scans to the end).
 */
function upperBound(prefix: string): string | null {
  if (prefix.length === 0) return null;
  const bytes = Buffer.from(prefix, 'utf8');
  for (let i = bytes.length - 1; i >= 0; i--) {
    if (bytes[i]! < 0xff) {
      const head = bytes.subarray(0, i + 1);
      head[i]! += 1;
      return head.toString('utf8');
    }
  }
  return null;
}

function toBuffer(data: Buffer | Uint8Array): Buffer {
  return Buffer.isBuffer(data) ? data : Buffer.from(data);
}

// Minimal structural types for the lazily-imported driver, so we don't take a
// hard type dependency on @types/better-sqlite3 at the call sites above.
interface BetterSqlite3Statement {
  run(...params: unknown[]): unknown;
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
}
interface BetterSqlite3Database {
  prepare(sql: string): BetterSqlite3Statement;
  exec(sql: string): unknown;
  pragma(source: string): unknown;
  transaction<A extends unknown[]>(fn: (...args: A) => void): (...args: A) => void;
  close(): unknown;
}
interface BetterSqlite3Constructor {
  new (filename: string): BetterSqlite3Database;
}
