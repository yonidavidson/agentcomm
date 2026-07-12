import { loadDriver } from './lazy.js';
import { upperBound } from './range.js';
/**
 * SqliteBackend — a faithful blob implementation of {@link Backend} backed by
 * a single SQLite database file in WAL mode. This is the recommended default
 * for the single-machine topology: no daemon, ACID, atomic per-key writes and
 * atomic `move` via a transaction.
 *
 * Also implements {@link Claimable}: SQLite's transaction lock serializes
 * concurrent `claim()` calls across processes (with `busy_timeout` smoothing
 * over contention), so the shared-worker-queue pattern is race-free here too.
 * It does NOT implement `Waitable` — per the project's pull-vs-push split,
 * only Postgres gets real push; SQLite (like the object stores) polls.
 *
 * The `better-sqlite3` driver is an OPTIONAL, LAZY-loaded dependency — exactly
 * like the s3/gcs backends — so the local filesystem backend stays
 * zero-dependency. A missing driver produces a clear "install it" error.
 *
 * NOTE: never place the database file on object storage (S3/GCS/gcsfuse).
 * SQLite needs a real filesystem with byte-range locks; over object storage
 * its locking guarantees break and concurrent writes corrupt the file.
 */
export class SqliteBackend {
    db;
    keyPrefix;
    constructor(db, 
    /** '' for the root channel, or 'channels/<name>/' for a carved channel. */
    keyPrefix) {
        this.db = db;
        this.keyPrefix = keyPrefix;
    }
    /**
     * Open (or create) the database at `filePath` and prepare the schema.
     * Lazy-imports better-sqlite3; throws {@link MissingDriverError} if absent.
     *
     * `channel` carves an isolated bus out of the file: every key is
     * transparently namespaced under `channels/<channel>/`, so N channels share
     * one .db without seeing each other. '' (default) is the root channel —
     * wire-compatible with data written before channels existed.
     */
    static async open(filePath, channel = '') {
        // Lazy, optional import. Resolved only when a sqlite:// URI is used.
        const mod = await loadDriver('better-sqlite3', 'better-sqlite3', 'the SQLite backend');
        const Database = mod.default;
        const db = new Database(filePath);
        // WAL gives concurrent readers + a single writer without a daemon.
        db.pragma('journal_mode = WAL');
        db.pragma('busy_timeout = 5000');
        db.pragma('synchronous = NORMAL');
        db.exec('CREATE TABLE IF NOT EXISTS blobs (key TEXT PRIMARY KEY, data BLOB NOT NULL)');
        return new SqliteBackend(db, channel ? `channels/${channel}/` : '');
    }
    k(key) {
        return this.keyPrefix + key;
    }
    async put(key, data) {
        this.db
            .prepare('INSERT INTO blobs (key, data) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET data = excluded.data')
            .run(this.k(key), data);
        return Promise.resolve();
    }
    async get(key) {
        const row = this.db.prepare('SELECT data FROM blobs WHERE key = ?').get(this.k(key));
        if (!row) {
            const err = new Error(`agentcomm: key not found: ${key}`);
            err.code = 'ENOENT';
            throw err;
        }
        return Promise.resolve(toBuffer(row.data));
    }
    async list(prefix) {
        // Range scan so the PRIMARY KEY index is used (no full scan, no LIKE).
        // Upper bound = prefix with its last byte incremented.
        const full = this.k(prefix);
        const upper = upperBound(full);
        const rows = upper === null
            ? this.db.prepare('SELECT key FROM blobs WHERE key >= ? ORDER BY key').all(full)
            : this.db
                .prepare('SELECT key FROM blobs WHERE key >= ? AND key < ? ORDER BY key')
                .all(full, upper);
        return Promise.resolve(rows.map((r) => r.key.slice(this.keyPrefix.length)));
    }
    async delete(key) {
        this.db.prepare('DELETE FROM blobs WHERE key = ?').run(this.k(key));
        return Promise.resolve();
    }
    async exists(key) {
        const row = this.db.prepare('SELECT 1 FROM blobs WHERE key = ?').get(this.k(key));
        return Promise.resolve(row !== undefined);
    }
    async move(src, dst) {
        // One transaction: copy src -> dst, drop src. Atomic. Started IMMEDIATE
        // (not deferred) — this transaction reads then writes, and a deferred
        // read-then-write under concurrent writers can hit SQLITE_BUSY_SNAPSHOT
        // (a stale read snapshot), which busy_timeout does not retry away.
        // Taking the write lock upfront avoids that class of failure entirely.
        const tx = this.db.transaction((from, to) => {
            const row = this.db.prepare('SELECT data FROM blobs WHERE key = ?').get(from);
            if (!row) {
                const err = new Error(`agentcomm: key not found: ${from}`);
                err.code = 'ENOENT';
                throw err;
            }
            this.db
                .prepare('INSERT INTO blobs (key, data) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET data = excluded.data')
                .run(to, row.data);
            this.db.prepare('DELETE FROM blobs WHERE key = ?').run(from);
        });
        tx.immediate(this.k(src), this.k(dst));
        return Promise.resolve();
    }
    async close() {
        this.db.close();
        return Promise.resolve();
    }
    /**
     * Atomically dequeue the oldest message from `inbox/<queue>/` and archive
     * it under `read/<queue>/` (same audit trail as `inbox`), in one
     * transaction. Returns null if the queue is empty.
     *
     * `owner` is the caller's claim of responsibility — SQLite's minimal blob
     * schema doesn't track who claimed what (no `owner`/`claimed_at` columns,
     * unlike the richer Postgres `messages` table); the returned Message is
     * the only record of the claim.
     */
    async claim(queue, _owner) {
        const prefix = this.k(`inbox/${queue}/`);
        const upper = upperBound(prefix);
        // IMMEDIATE for the same reason as move(): this is a read-then-write
        // transaction, and deferred mode risks SQLITE_BUSY_SNAPSHOT under
        // concurrent claimers racing on the same queue.
        const tx = this.db.transaction(() => {
            const row = (upper === null
                ? this.db.prepare('SELECT key, data FROM blobs WHERE key >= ? ORDER BY key LIMIT 1').get(prefix)
                : this.db
                    .prepare('SELECT key, data FROM blobs WHERE key >= ? AND key < ? ORDER BY key LIMIT 1')
                    .get(prefix, upper));
            if (!row)
                return null;
            const logical = row.key.slice(this.keyPrefix.length);
            const dst = this.k('read/' + logical.slice('inbox/'.length));
            this.db
                .prepare('INSERT INTO blobs (key, data) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET data = excluded.data')
                .run(dst, row.data);
            this.db.prepare('DELETE FROM blobs WHERE key = ?').run(row.key);
            return JSON.parse(toBuffer(row.data).toString('utf8'));
        });
        return Promise.resolve(tx.immediate());
    }
}
function toBuffer(data) {
    return Buffer.isBuffer(data) ? data : Buffer.from(data);
}
//# sourceMappingURL=sqlite.js.map