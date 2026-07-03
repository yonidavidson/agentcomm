import { type Backend, type Claimable, type Message } from '../types.js';
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
export declare class SqliteBackend implements Backend, Claimable {
    private readonly db;
    /** '' for the root channel, or 'channels/<name>/' for a carved channel. */
    private readonly keyPrefix;
    private constructor();
    /**
     * Open (or create) the database at `filePath` and prepare the schema.
     * Lazy-imports better-sqlite3; throws {@link MissingDriverError} if absent.
     *
     * `channel` carves an isolated bus out of the file: every key is
     * transparently namespaced under `channels/<channel>/`, so N channels share
     * one .db without seeing each other. '' (default) is the root channel —
     * wire-compatible with data written before channels existed.
     */
    static open(filePath: string, channel?: string): Promise<SqliteBackend>;
    private k;
    put(key: string, data: Buffer): Promise<void>;
    get(key: string): Promise<Buffer>;
    list(prefix: string): Promise<string[]>;
    delete(key: string): Promise<void>;
    exists(key: string): Promise<boolean>;
    move(src: string, dst: string): Promise<void>;
    close(): Promise<void>;
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
    claim(queue: string, _owner: string): Promise<Message | null>;
}
//# sourceMappingURL=sqlite.d.ts.map