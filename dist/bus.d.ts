import { type Backend, type Message } from './types.js';
/**
 * The Bus implements the mailbox semantics on top of any {@link Backend}.
 * It only ever uses the blob primitives, so every backend works identically.
 *
 * Key layout:
 *   agents/<name>.json                  registry + heartbeat
 *   inbox/<recipient>/<seq>_<id>.json   undelivered messages
 *   read/<recipient>/<seq>_<id>.json    archived after consumption
 *
 * `<seq>` is a zero-padded, monotonic, lexicographically-sortable prefix, so
 * `list()` returns messages in send order. It lives only in the key, never
 * in the stored message body.
 *
 * A "queue" (for {@link claim}) is the same namespace as a recipient inbox —
 * `send <queue> ...` populates it, `claim --queue <queue>` atomically
 * dequeues from it instead of a single consumer reading via `inbox`.
 */
export declare class Bus {
    private readonly backend;
    constructor(backend: Backend);
    register(name: string, session?: string, status?: string, statusAuto?: boolean): Promise<AgentRecord & {
        previous?: AgentRecord;
    }>;
    agents(): Promise<AgentRecord[]>;
    private tryGetAgent;
    send(input: SendInput): Promise<Message>;
    /** Send to every registered agent except the sender. Returns delivered copies. */
    broadcast(input: Omit<SendInput, 'to'>): Promise<Message[]>;
    private materialize;
    /** Consume: read all undelivered messages for `recipient`, archive under read/. */
    inbox(recipient: string): Promise<Message[]>;
    /** Non-consuming: read undelivered messages for `recipient` without archiving. */
    peek(recipient: string): Promise<Message[]>;
    /**
     * Block until at least one message is waiting for `recipient`, or timeout.
     * Non-consuming (like peek) — returns the pending messages.
     *
     * Uses the backend's push capability ({@link Waitable.waitPush}) when
     * present; otherwise falls back to polling `peek`. Same contract either
     * way: resolves with [] on timeout so the CLI can map that to exit code 2.
     */
    wait(recipient: string, timeoutMs: number, pollMs?: number): Promise<Message[]>;
    /**
     * Atomically claim one message from `queue` (the same namespace as a
     * recipient inbox) on behalf of `owner`. Requires a backend implementing
     * {@link Claimable} (SQL backends only) — throws a clear error otherwise.
     * Returns null if the queue is currently empty.
     */
    claim(queue: string, owner: string): Promise<Message | null>;
}
export interface SendInput {
    from: string;
    to: string;
    subject?: string;
    body: string;
    thread?: string;
}
export interface AgentRecord {
    name: string;
    registeredAt: string;
    lastSeen: string;
    /** Fingerprint of the registering session — lets tooling tell "stale me" from "someone else". */
    session?: string;
    /** "What I'm doing" — from register --status (explicit, sticky) or the task list (auto). */
    status?: string;
    /** True when the status came from the task list; explicit declarations set false and win. */
    statusAuto?: boolean;
}
//# sourceMappingURL=bus.d.ts.map