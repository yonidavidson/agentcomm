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
  /**
   * Optional hint: how often `Bus.wait` should poll this store, in ms.
   * Backends where every poll costs real quota (e.g. github's shared
   * 5,000/hr REST limit) declare a gentler cadence than the 250ms default.
   * An explicit caller-supplied interval always wins.
   */
  readonly pollIntervalMs?: number;
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

/**
 * Optional capability: read every key (and body) under a prefix in one
 * atomic pass. On stores where each `get` pays a network round trip (a git
 * fetch, a REST call), warming a large bus key-by-key is minutes of wall
 * clock — the bus daemon uses this to warm its mirror in one round trip.
 */
export interface Snapshottable {
  /**
   * Every key under `prefix` at a single consistent point, with the bodies
   * `opts.bodies` selects (all of them when it is absent).
   *
   * The split matters because a bus's history only grows: re-reading every
   * archived body on every poll makes the daemon cost scale with all history
   * rather than with what is hot (issue #167). Keys are cheap to list, so
   * callers still see the whole store and fetch a cold body on demand.
   */
  snapshot(
    prefix: string,
    opts?: { bodies?: (key: string) => boolean },
  ): Promise<{ keys: string[]; bodies: Map<string, Buffer> }>;
}

/**
 * Optional capability: apply many moves as ONE store operation. Consuming a
 * mailbox archives every message it delivered; key-by-key that is a network
 * round trip per message (a git commit+push each), which is what made `inbox`
 * time out where `peek` was instant (issue #159). Backends that can commit a
 * batch declare it here; the Bus falls back to per-key moves without it.
 */
export interface Batchable {
  /** Move every pair, atomically where the store allows it. */
  moveMany(moves: { src: string; dst: string }[]): Promise<void>;
}

/** Optional capability: block until a message arrives (push instead of poll). */
export interface Waitable {
  /**
   * Wait up to `timeoutMs` for messages addressed to `agent`. Returns the
   * messages that arrived (may be empty on timeout). Does not consume them.
   */
  waitPush(agent: string, timeoutMs: number): Promise<Message[]>;
}

export function isClaimable(b: Backend): b is Backend & Claimable {
  return typeof (b as Partial<Claimable>).claim === 'function';
}

export function isBatchable(b: Backend): b is Backend & Batchable {
  return typeof (b as Partial<Batchable>).moveMany === 'function';
}

export function isWaitable(b: Backend): b is Backend & Waitable {
  return typeof (b as Partial<Waitable>).waitPush === 'function';
}

export function isSnapshottable(b: Backend): b is Backend & Snapshottable {
  return typeof (b as Partial<Snapshottable>).snapshot === 'function';
}

/** Thrown when an optional driver (better-sqlite3, pg, aws/gcs sdk) is missing. */
export class MissingDriverError extends Error {
  constructor(pkg: string, forWhat: string) {
    super(
      `agentcomm: ${forWhat} requires the optional dependency "${pkg}", which is not installed.\n` +
        `Install it with:  npm install ${pkg}`,
    );
    this.name = 'MissingDriverError';
  }
}
