import { randomUUID } from 'node:crypto';
import { isBatchable, isClaimable, isWaitable, type Backend, type Message } from './types.js';

/** How long an explicit status stays sticky before a newer task can refresh it. */
const EXPLICIT_STICKY_MS = Number(process.env.AGENTCOMM_EXPLICIT_STICKY_MS ?? 15 * 60_000);

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
    statusAuto = false,
  ): Promise<AgentRecord & { previous?: AgentRecord }> {
    assertName(name);
    const now = new Date().toISOString();
    const existing = await this.tryGetAgent(name);
    // Status precedence: an EXPLICIT declaration (register --status) wins over
    // an AUTO status (task list) while it is FRESH, so a rich narrative isn't
    // clobbered by terse task subjects mid-work. But stickiness is bounded —
    // once the explicit status is stale, a newer task takes over, so the
    // board can't freeze on old work. A heartbeat (no status arg) preserves.
    let nextStatus = existing?.status;
    let nextAuto = existing?.statusAuto;
    let nextStatusAt = existing?.statusAt;
    if (status !== undefined) {
      const explicitAge = existing?.statusAt ? Date.parse(now) - Date.parse(existing.statusAt) : Infinity;
      const explicitStands =
        existing?.status != null && existing.statusAuto === false && explicitAge < EXPLICIT_STICKY_MS;
      if (!statusAuto || !explicitStands) {
        nextStatus = status;
        nextAuto = statusAuto;
        nextStatusAt = now;
      }
    }
    const record: AgentRecord = {
      name,
      registeredAt: existing?.registeredAt ?? now,
      lastSeen: now,
      ...(existing?.lastRead ? { lastRead: existing.lastRead } : {}),
      ...(session ? { session } : {}),
      ...(nextStatus ? { status: nextStatus, statusAuto: nextAuto, statusAt: nextStatusAt } : {}),
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

  /**
   * Record that `name` consumed its mailbox. A send reports success whether
   * or not anyone is reading; this is the other half of that story, and it
   * costs one write on a command agents run a handful of times a session.
   *
   * Only an EXISTING registration is stamped. Reading must not create one:
   * registrations are never purged, so a one-off `inbox --as someone` would
   * put a permanent ghost on the roster. An unregistered reader simply has
   * no read history — which is exactly what `send` reports about it.
   */
  async markRead(name: string): Promise<void> {
    assertName(name);
    const existing = await this.tryGetAgent(name);
    if (!existing) return;
    const now = new Date().toISOString();
    await this.backend.put(agentKey(name), encode({ ...existing, lastSeen: now, lastRead: now }));
  }

  /**
   * Undelivered message count per recipient, from KEYS alone — one list, no
   * bodies. Mailboxes with no registration count too: mail addressed to a
   * name nobody is reading is precisely what needs surfacing.
   */
  async unreadCounts(): Promise<Record<string, number>> {
    const counts: Record<string, number> = {};
    for (const key of await this.backend.list('inbox/')) {
      if (!key.endsWith('.json')) continue;
      const recipient = key.slice('inbox/'.length, key.indexOf('/', 'inbox/'.length));
      if (recipient) counts[recipient] = (counts[recipient] ?? 0) + 1;
    }
    return counts;
  }

  /** Undelivered count for one recipient — the cheap pre-send check. */
  async unread(recipient: string): Promise<number> {
    assertName(recipient);
    return (await this.backend.list(inboxPrefix(recipient))).filter((k) => k.endsWith('.json')).length;
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

  /**
   * Consume: read all undelivered messages for `recipient`, hand them to
   * `deliver`, and only then archive under read/.
   *
   * The order is the contract (issue #158). Archiving as we read meant a
   * command that died mid-flight — a harness timeout, a Ctrl-C, a broken pipe
   * — left messages consumed AND undelivered: unrecoverable loss on the
   * normal path. Delivering first makes the worst case a duplicate: whatever
   * `deliver` accepted is out, and anything not archived is simply still
   * pending. `deliver` must not resolve until the messages are durably in the
   * caller's hands (the CLI waits for stdout to flush).
   */
  async inbox(
    recipient: string,
    opts: {
      /** Hand the messages to the caller. Must resolve only once they are durably received. */
      deliver?: (messages: Message[]) => Promise<void> | void;
      /** Delivered but still pending (archiving failed) — they will arrive again. */
      onUnarchived?: (keys: string[]) => void;
    } = {},
  ): Promise<Message[]> {
    assertName(recipient);
    const pending = await this.pending(recipient);
    const messages = pending.map((p) => p.message);
    await opts.deliver?.(messages);
    if (messages.length > 0) {
      const failed = await this.archive(pending.map((p) => p.key));
      if (failed.length > 0) opts.onUnarchived?.(failed);
    }
    return messages;
  }

  /** Non-consuming: read undelivered messages for `recipient` without archiving. */
  async peek(recipient: string): Promise<Message[]> {
    return (await this.pending(recipient)).map((p) => p.message);
  }

  /** Undelivered messages for `recipient`, each with the inbox key holding it. */
  async pending(recipient: string): Promise<{ key: string; message: Message }[]> {
    assertName(recipient);
    const out: { key: string; message: Message }[] = [];
    for (const key of await this.backend.list(inboxPrefix(recipient))) {
      if (!key.endsWith('.json')) continue;
      try {
        out.push({ key, message: decode<Message>(await this.backend.get(key)) });
      } catch {
        continue; // vanished (raced consumer) or corrupt
      }
    }
    return out;
  }

  /**
   * Clear mail that has already been read (issue #160). `peek` shows messages
   * without consuming and `inbox` consumes what it shows — with only those
   * two, an agent that read its mail the non-destructive way could never mark
   * it read, so the unread count (and the stop guard behind it) stayed stuck
   * at N forever. Acking works off the KEYS: no body is re-fetched, and ids
   * that are not pending are reported rather than silently ignored.
   */
  async ack(
    recipient: string,
    ids: string[] | 'all',
  ): Promise<{ acked: string[]; unknown: string[]; failed: string[] }> {
    assertName(recipient);
    const keys = (await this.backend.list(inboxPrefix(recipient))).filter((k) => k.endsWith('.json'));
    const byId = new Map(keys.map((key) => [messageIdFromKey(key), key] as const));
    const wanted = ids === 'all' ? [...byId.keys()] : ids;
    const unknown = wanted.filter((id) => !byId.has(id));
    const targets = wanted.filter((id) => byId.has(id));
    const failedKeys = await this.archive(targets.map((id) => byId.get(id)!));
    const failed = targets.filter((id) => failedKeys.includes(byId.get(id)!));
    return { acked: targets.filter((id) => !failed.includes(id)), unknown, failed };
  }

  /**
   * Archive (don't hard-delete) inbox keys under read/, preserving the audit
   * trail. Returns the keys that could NOT be archived — a raced consumer, or
   * a store that went away mid-run; they stay pending and re-deliver.
   */
  async archive(keys: string[]): Promise<string[]> {
    if (keys.length === 0) return [];
    // One store operation for the whole mailbox where the backend can do it
    // (issue #159): key-by-key, archiving a full inbox is a network round
    // trip per message and the command times out before it finishes.
    if (isBatchable(this.backend)) {
      try {
        await this.backend.moveMany(keys.map((key) => ({ src: key, dst: readKeyFromInboxKey(key) })));
        return [];
      } catch {
        // fall through: retry key-by-key, so a batch that failed as a whole
        // still archives whatever it individually can
      }
    }
    const failed: string[] = [];
    for (const key of keys) {
      try {
        await this.backend.move(key, readKeyFromInboxKey(key));
      } catch {
        failed.push(key);
      }
    }
    return failed;
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
/** The message id a key carries: inbox/<to>/<seq>_<id>.json — no read needed. */
function messageIdFromKey(key: string): string {
  return key.slice(key.lastIndexOf('_') + 1).replace(/\.json$/, '');
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
  /** "What I'm doing" — from register --status (explicit, sticky) or the task list (auto). */
  status?: string;
  /** True when the status came from the task list; explicit declarations set false and win while fresh. */
  statusAuto?: boolean;
  /** ISO 8601 time the status was set — bounds how long an explicit one stays sticky. */
  statusAt?: string;
  /**
   * ISO 8601 time this agent last CONSUMED its mailbox (issue #162). `sent`
   * only ever meant "queued"; this is what makes "and someone read it"
   * answerable — a recipient with mail piling up and no read for hours is
   * worth surfacing to whoever is sending it work.
   */
  lastRead?: string;
}
