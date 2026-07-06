import { randomUUID } from 'node:crypto';
import { isClaimable, isWaitable, type Backend, type Message } from './types.js';

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
export class Bus {
  constructor(private readonly backend: Backend) {}

  // ── agents ──────────────────────────────────────────────────────────────

  async register(
    name: string,
    session?: string,
    status?: string,
  ): Promise<AgentRecord & { previous?: AgentRecord }> {
    assertName(name);
    const now = new Date().toISOString();
    const existing = await this.tryGetAgent(name);
    const record: AgentRecord = {
      name,
      registeredAt: existing?.registeredAt ?? now,
      lastSeen: now,
      ...(session ? { session } : {}),
      // a heartbeat (no explicit status) must not erase the declared status
      ...((status ?? existing?.status) ? { status: status ?? existing?.status } : {}),
    };
    await this.backend.put(agentKey(name), encode(record));
    // The previous record lets callers detect an alias collision: same name,
    // fresh lastSeen, DIFFERENT session = two live processes sharing a
    // consuming mailbox.
    return existing ? { ...record, previous: existing } : record;
  }

  async agents(): Promise<AgentRecord[]> {
    const keys = await this.backend.list('agents/');
    const out: AgentRecord[] = [];
    for (const key of keys) {
      if (!key.endsWith('.json')) continue;
      try {
        out.push(decode<AgentRecord>(await this.backend.get(key)));
      } catch {
        // tolerate a partially-written/corrupt registry entry
      }
    }
    out.sort((a, b) => a.name.localeCompare(b.name));
    return out;
  }

  private async tryGetAgent(name: string): Promise<AgentRecord | null> {
    try {
      return decode<AgentRecord>(await this.backend.get(agentKey(name)));
    } catch {
      return null;
    }
  }

  // ── sending ─────────────────────────────────────────────────────────────

  async send(input: SendInput): Promise<Message> {
    assertName(input.to);
    const msg = this.materialize(input);
    await this.backend.put(inboxKey(input.to, nextSeq(), msg.id), encode(msg));
    return msg;
  }

  /** Send to every registered agent except the sender. Returns delivered copies. */
  async broadcast(input: Omit<SendInput, 'to'>): Promise<Message[]> {
    const recipients = (await this.agents()).map((a) => a.name).filter((n) => n !== input.from);
    const sent: Message[] = [];
    for (const to of recipients) {
      sent.push(await this.send({ ...input, to }));
    }
    return sent;
  }

  private materialize(input: SendInput): Message {
    return {
      id: randomUUID().replace(/-/g, '').slice(0, 12),
      from: input.from,
      to: input.to,
      ...(input.subject !== undefined ? { subject: input.subject } : {}),
      body: input.body,
      ts: new Date().toISOString(),
      ...(input.thread !== undefined ? { thread: input.thread } : {}),
    };
  }

  // ── receiving ───────────────────────────────────────────────────────────

  /** Consume: read all undelivered messages for `recipient`, archive under read/. */
  async inbox(recipient: string): Promise<Message[]> {
    assertName(recipient);
    const keys = await this.backend.list(inboxPrefix(recipient));
    const out: Message[] = [];
    for (const key of keys) {
      if (!key.endsWith('.json')) continue;
      let msg: Message;
      try {
        msg = decode<Message>(await this.backend.get(key));
      } catch {
        continue; // skip a key that vanished (raced consumer) or is corrupt
      }
      // Archive (don't hard-delete): preserve the audit trail under read/.
      const dst = readKeyFromInboxKey(key);
      try {
        await this.backend.move(key, dst);
      } catch {
        continue; // another consumer claimed it first
      }
      out.push(msg);
    }
    return out;
  }

  /** Non-consuming: read undelivered messages for `recipient` without archiving. */
  async peek(recipient: string): Promise<Message[]> {
    assertName(recipient);
    const keys = await this.backend.list(inboxPrefix(recipient));
    const out: Message[] = [];
    for (const key of keys) {
      if (!key.endsWith('.json')) continue;
      try {
        out.push(decode<Message>(await this.backend.get(key)));
      } catch {
        continue;
      }
    }
    return out;
  }

  /**
   * Block until at least one message is waiting for `recipient`, or timeout.
   * Non-consuming (like peek) — returns the pending messages.
   *
   * Uses the backend's push capability ({@link Waitable.waitPush}) when
   * present; otherwise falls back to polling `peek`. Same contract either
   * way: resolves with [] on timeout so the CLI can map that to exit code 2.
   */
  async wait(recipient: string, timeoutMs: number, pollMs?: number): Promise<Message[]> {
    assertName(recipient);
    if (isWaitable(this.backend)) {
      return this.backend.waitPush(recipient, timeoutMs);
    }
    // Explicit caller interval wins; otherwise the backend's declared cadence
    // (github polls gently — every poll is metered API quota); otherwise 250ms.
    const interval = pollMs ?? this.backend.pollIntervalMs ?? 250;
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const pending = await this.peek(recipient);
      if (pending.length > 0) return pending;
      if (Date.now() >= deadline) return [];
      await sleep(Math.min(interval, Math.max(0, deadline - Date.now())));
    }
  }

  // ── shared-queue claims ────────────────────────────────────────────────

  /**
   * Atomically claim one message from `queue` (the same namespace as a
   * recipient inbox) on behalf of `owner`. Requires a backend implementing
   * {@link Claimable} (SQL backends only) — throws a clear error otherwise.
   * Returns null if the queue is currently empty.
   */
  async claim(queue: string, owner: string): Promise<Message | null> {
    assertName(queue);
    assertName(owner);
    if (!isClaimable(this.backend)) {
      throw new Error(
        'agentcomm: this backend does not support claim() — use a SQL backend (sqlite:// or postgres://).',
      );
    }
    return this.backend.claim(queue, owner);
  }
}

// ── key helpers ─────────────────────────────────────────────────────────────

function agentKey(name: string): string {
  return `agents/${name}.json`;
}
function inboxPrefix(recipient: string): string {
  return `inbox/${recipient}/`;
}
function inboxKey(recipient: string, seq: string, id: string): string {
  return `inbox/${recipient}/${seq}_${id}.json`;
}
function readKeyFromInboxKey(inboxKey: string): string {
  return 'read/' + inboxKey.slice('inbox/'.length);
}

// ── sequence generation ─────────────────────────────────────────────────────

let _counter = 0;
/** Monotonic, lexicographically-sortable sequence prefix: <ms>-<counter>. */
function nextSeq(): string {
  const ms = Date.now().toString().padStart(15, '0');
  const c = (_counter++ % 1_000_000).toString().padStart(6, '0');
  return `${ms}-${c}`;
}

// ── (de)serialization ───────────────────────────────────────────────────────

function encode(value: unknown): Buffer {
  return Buffer.from(JSON.stringify(value), 'utf8');
}
function decode<T>(buf: Buffer): T {
  return JSON.parse(buf.toString('utf8')) as T;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function assertName(name: string): void {
  if (!name || !/^[A-Za-z0-9._-]+$/.test(name)) {
    throw new Error(
      `agentcomm: invalid agent name "${name}". Use letters, digits, '.', '_' or '-'.`,
    );
  }
}

// ── public input/record shapes ──────────────────────────────────────────────

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
  /** Self-declared "what I'm doing" — set via register --status, kept across heartbeats. */
  status?: string;
}
