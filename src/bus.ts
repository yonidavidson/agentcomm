import { randomUUID } from 'node:crypto';
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
export class Bus {
  constructor(private readonly backend: Backend) {}

  // ── agents ──────────────────────────────────────────────────────────────

  async register(name: string): Promise<AgentRecord> {
    assertName(name);
    const now = new Date().toISOString();
    const existing = await this.tryGetAgent(name);
    const record: AgentRecord = {
      name,
      registeredAt: existing?.registeredAt ?? now,
      lastSeen: now,
    };
    await this.backend.put(agentKey(name), encode(record));
    return record;
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
    await this.backend.put(inboxKey(input.to, msg), encode(msg));
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
    const id = randomUUID().replace(/-/g, '').slice(0, 12);
    const seq = nextSeq();
    return {
      id,
      from: input.from,
      to: input.to,
      ...(input.subject !== undefined ? { subject: input.subject } : {}),
      body: input.body,
      ts: new Date().toISOString(),
      ...(input.thread !== undefined ? { thread: input.thread } : {}),
      // seq is encoded into the key, not the message body; keep both for sort
      _seq: seq,
    } as Message & { _seq: string };
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
      out.push(stripInternal(msg));
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
        out.push(stripInternal(decode<Message>(await this.backend.get(key))));
      } catch {
        continue;
      }
    }
    return out;
  }

  /**
   * Block until at least one message is waiting for `recipient`, or timeout.
   * Non-consuming (like peek) — returns the pending messages. Poll-based;
   * push-capable backends are wired in a later task.
   *
   * Resolves with [] on timeout so the CLI can map that to exit code 2.
   */
  async wait(
    recipient: string,
    timeoutMs: number,
    pollMs = 250,
  ): Promise<Message[]> {
    assertName(recipient);
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const pending = await this.peek(recipient);
      if (pending.length > 0) return pending;
      if (Date.now() >= deadline) return [];
      await sleep(Math.min(pollMs, Math.max(0, deadline - Date.now())));
    }
  }
}

// ── key helpers ─────────────────────────────────────────────────────────────

function agentKey(name: string): string {
  return `agents/${name}.json`;
}
function inboxPrefix(recipient: string): string {
  return `inbox/${recipient}/`;
}
function inboxKey(recipient: string, msg: Message & { _seq?: string }): string {
  return `inbox/${recipient}/${msg._seq}_${msg.id}.json`;
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
function stripInternal(msg: Message & { _seq?: string }): Message {
  const { _seq, ...rest } = msg;
  return rest;
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
}
