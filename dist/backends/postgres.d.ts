import { type Backend, type Claimable, type Message, type Waitable } from '../types.js';
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
export declare class PostgresBackend implements Backend, Claimable, Waitable {
    private readonly client;
    private readonly pg;
    private constructor();
    static open(connectionUri: string): Promise<PostgresBackend>;
    put(key: string, data: Buffer): Promise<void>;
    get(key: string): Promise<Buffer>;
    list(prefix: string): Promise<string[]>;
    delete(key: string): Promise<void>;
    exists(key: string): Promise<boolean>;
    move(src: string, dst: string): Promise<void>;
    /** Atomically dequeue the oldest message in `inbox/<queue>/`. See class doc. */
    claim(queue: string, _owner: string): Promise<Message | null>;
    /** Push-driven wait: LISTEN on the recipient's channel, NOTIFY'd by put(). See class doc. */
    waitPush(recipient: string, timeoutMs: number): Promise<Message[]>;
    private listMessages;
    close(): Promise<void>;
}
//# sourceMappingURL=postgres.d.ts.map