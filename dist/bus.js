import { randomUUID } from 'node:crypto';
import { isClaimable, isWaitable } from './types.js';
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
    backend;
    constructor(backend) {
        this.backend = backend;
    }
    // ── agents ──────────────────────────────────────────────────────────────
    async register(name, session, status, statusAuto = false) {
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
            const explicitStands = existing?.status != null && existing.statusAuto === false && explicitAge < EXPLICIT_STICKY_MS;
            if (!statusAuto || !explicitStands) {
                nextStatus = status;
                nextAuto = statusAuto;
                nextStatusAt = now;
            }
        }
        const record = {
            name,
            registeredAt: existing?.registeredAt ?? now,
            lastSeen: now,
            ...(session ? { session } : {}),
            ...(nextStatus ? { status: nextStatus, statusAuto: nextAuto, statusAt: nextStatusAt } : {}),
        };
        await this.backend.put(agentKey(name), encode(record));
        // The previous record lets callers detect an alias collision: same name,
        // fresh lastSeen, DIFFERENT session = two live processes sharing a
        // consuming mailbox.
        return existing ? { ...record, previous: existing } : record;
    }
    async agents() {
        const keys = await this.backend.list('agents/');
        const out = [];
        for (const key of keys) {
            if (!key.endsWith('.json'))
                continue;
            try {
                out.push(decode(await this.backend.get(key)));
            }
            catch {
                // tolerate a partially-written/corrupt registry entry
            }
        }
        out.sort((a, b) => a.name.localeCompare(b.name));
        return out;
    }
    async tryGetAgent(name) {
        try {
            return decode(await this.backend.get(agentKey(name)));
        }
        catch {
            return null;
        }
    }
    // ── sending ─────────────────────────────────────────────────────────────
    async send(input) {
        assertName(input.to);
        const msg = this.materialize(input);
        await this.backend.put(inboxKey(input.to, nextSeq(), msg.id), encode(msg));
        return msg;
    }
    /** Send to every registered agent except the sender. Returns delivered copies. */
    async broadcast(input) {
        const recipients = (await this.agents()).map((a) => a.name).filter((n) => n !== input.from);
        const sent = [];
        for (const to of recipients) {
            sent.push(await this.send({ ...input, to }));
        }
        return sent;
    }
    materialize(input) {
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
    async inbox(recipient) {
        assertName(recipient);
        const keys = await this.backend.list(inboxPrefix(recipient));
        const out = [];
        for (const key of keys) {
            if (!key.endsWith('.json'))
                continue;
            let msg;
            try {
                msg = decode(await this.backend.get(key));
            }
            catch {
                continue; // skip a key that vanished (raced consumer) or is corrupt
            }
            // Archive (don't hard-delete): preserve the audit trail under read/.
            const dst = readKeyFromInboxKey(key);
            try {
                await this.backend.move(key, dst);
            }
            catch {
                continue; // another consumer claimed it first
            }
            out.push(msg);
        }
        return out;
    }
    /** Non-consuming: read undelivered messages for `recipient` without archiving. */
    async peek(recipient) {
        assertName(recipient);
        const keys = await this.backend.list(inboxPrefix(recipient));
        const out = [];
        for (const key of keys) {
            if (!key.endsWith('.json'))
                continue;
            try {
                out.push(decode(await this.backend.get(key)));
            }
            catch {
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
    async wait(recipient, timeoutMs, pollMs) {
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
            if (pending.length > 0)
                return pending;
            if (Date.now() >= deadline)
                return [];
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
    async claim(queue, owner) {
        assertName(queue);
        assertName(owner);
        if (!isClaimable(this.backend)) {
            throw new Error('agentcomm: this backend does not support claim() — use a SQL backend (sqlite:// or postgres://).');
        }
        return this.backend.claim(queue, owner);
    }
}
// ── key helpers ─────────────────────────────────────────────────────────────
function agentKey(name) {
    return `agents/${name}.json`;
}
function inboxPrefix(recipient) {
    return `inbox/${recipient}/`;
}
function inboxKey(recipient, seq, id) {
    return `inbox/${recipient}/${seq}_${id}.json`;
}
function readKeyFromInboxKey(inboxKey) {
    return 'read/' + inboxKey.slice('inbox/'.length);
}
// ── sequence generation ─────────────────────────────────────────────────────
let _counter = 0;
/** Monotonic, lexicographically-sortable sequence prefix: <ms>-<counter>. */
function nextSeq() {
    const ms = Date.now().toString().padStart(15, '0');
    const c = (_counter++ % 1_000_000).toString().padStart(6, '0');
    return `${ms}-${c}`;
}
// ── (de)serialization ───────────────────────────────────────────────────────
function encode(value) {
    return Buffer.from(JSON.stringify(value), 'utf8');
}
function decode(buf) {
    return JSON.parse(buf.toString('utf8'));
}
function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
}
function assertName(name) {
    if (!name || !/^[A-Za-z0-9._-]+$/.test(name)) {
        throw new Error(`agentcomm: invalid agent name "${name}". Use letters, digits, '.', '_' or '-'.`);
    }
}
//# sourceMappingURL=bus.js.map