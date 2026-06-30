/**
 * Core types for agentcomm.
 *
 * The {@link Backend} interface is the seam the whole project is built around:
 * a tiny blob store (put/get/list/delete/exists/move) that every storage
 * engine implements. The Bus is written purely against this interface, so a
 * new transport is "just" a new Backend.
 *
 * Richer backends (SQL) may additionally implement the optional capability
 * interfaces {@link Claimable} and {@link Waitable}. The Bus feature-detects
 * these at runtime and falls back to the blob primitives when they are absent.
 */
/** A message as it travels through the bus. */
export interface Message {
    id: string;
    from: string;
    to: string;
    subject?: string;
    body: string;
    /** ISO 8601 timestamp. */
    ts: string;
    thread?: string;
}
/**
 * The storage seam. Keys are opaque strings; values are arbitrary bytes.
 * Implementations must be safe for the single-consumer-per-inbox model the
 * Bus relies on. `put` and `move` must be atomic per key where the underlying
 * store allows it.
 */
export interface Backend {
    /** Overwrite the value at `key`. Atomic per key. */
    put(key: string, data: Buffer): Promise<void>;
    /** Read the value at `key`. Throws if absent. */
    get(key: string): Promise<Buffer>;
    /** Keys having the given prefix, sorted ascending. */
    list(prefix: string): Promise<string[]>;
    /** Remove `key`. No-op if absent. */
    delete(key: string): Promise<void>;
    /** Whether `key` exists. */
    exists(key: string): Promise<boolean>;
    /** Move `src` to `dst`. Atomic where the store allows it. */
    move(src: string, dst: string): Promise<void>;
    /** Optional teardown (close DB handles, pools, …). */
    close?(): Promise<void>;
}
/**
 * Optional capability: atomically claim one message from a shared queue.
 * Enables the multiple-workers / one-inbox pattern. Only SQL backends
 * implement this — object stores keep the race-free single-consumer model.
 */
export interface Claimable {
    /**
     * Atomically remove and return the next undelivered message for `queue`,
     * marking it owned by `owner`. Returns null if the queue is empty.
     */
    claim(queue: string, owner: string): Promise<Message | null>;
}
/** Optional capability: block until a message arrives (push instead of poll). */
export interface Waitable {
    /**
     * Wait up to `timeoutMs` for messages addressed to `agent`. Returns the
     * messages that arrived (may be empty on timeout). Does not consume them.
     */
    waitPush(agent: string, timeoutMs: number): Promise<Message[]>;
}
export declare function isClaimable(b: Backend): b is Backend & Claimable;
export declare function isWaitable(b: Backend): b is Backend & Waitable;
/** Thrown when an optional driver (better-sqlite3, pg, aws/gcs sdk) is missing. */
export declare class MissingDriverError extends Error {
    constructor(pkg: string, forWhat: string);
}
//# sourceMappingURL=types.d.ts.map