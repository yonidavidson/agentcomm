import type { Backend, Message } from './types.js';
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
 * `list()` returns messages in send order.
 */
export declare class Bus {
    private readonly backend;
    constructor(backend: Backend);
    register(name: string): Promise<AgentRecord>;
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
     * Non-consuming (like peek) — returns the pending messages. Poll-based;
     * push-capable backends are wired in a later task.
     *
     * Resolves with [] on timeout so the CLI can map that to exit code 2.
     */
    wait(recipient: string, timeoutMs: number, pollMs?: number): Promise<Message[]>;
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
}
//# sourceMappingURL=bus.d.ts.map