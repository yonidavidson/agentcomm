/**
 * Telemetry events — the append-only lane beside the mailbox (issue #100).
 *
 * Where messages are addressed and consume-on-read, events are broadcast
 * facts ("skill X ran", "branch Y merged") written once and read many times.
 * They live under their own key prefix on the same {@link Backend} seam:
 *
 *   events/<seq>_<batchId>.json    one blob per FLUSH — a batch, not an event
 *
 * Capture is local and free: `emit` appends to a per-(bus, agent) JSONL
 * spool in tmpdir. The spool drains into a single batch blob whenever the
 * CLI performs a bus write it was going to make anyway (register, send,
 * broadcast), so the backend sees no new write cadence — just fatter
 * payloads. Delivery is at-most-once by design: losing a spool tail on a
 * crash is inside the loss budget; polluting the mailbox lane is not.
 */
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
export const EVENTS_PREFIX = 'events/';
// ── spool ───────────────────────────────────────────────────────────────────
// Capture must be fast, offline, and unable to break the caller: append a
// JSONL line to a tmpdir file keyed by (bus URI, agent). Draining claims the
// whole file with an atomic rename, so concurrent flushers never double-ship
// a batch — the loser of the rename race simply finds nothing to drain.
export function spoolPath(busUri, agent) {
    const key = createHash('sha1').update(`${busUri}\0${agent}`).digest('hex').slice(0, 16);
    return path.join(os.tmpdir(), `agentcomm-events-${key}.jsonl`);
}
/** Append events to the local spool. Never throws — capture is best-effort. */
export async function spoolEvents(busUri, agent, events) {
    if (events.length === 0)
        return true;
    try {
        const lines = events.map((e) => JSON.stringify(e)).join('\n') + '\n';
        await fs.appendFile(spoolPath(busUri, agent), lines, 'utf8');
        return true;
    }
    catch {
        return false;
    }
}
/** How many events are waiting locally (0 on any error — used as a cheap pre-flush check). */
export async function spoolDepth(busUri, agent) {
    try {
        const raw = await fs.readFile(spoolPath(busUri, agent), 'utf8');
        return raw.split('\n').filter((l) => l.trim()).length;
    }
    catch {
        return 0;
    }
}
/** Atomically claim and parse the spool. Empty array when there is nothing (or on a lost race). */
async function drainSpool(busUri, agent) {
    const file = spoolPath(busUri, agent);
    const claimed = `${file}.${process.pid}.${randomUUID().slice(0, 8)}.draining`;
    try {
        await fs.rename(file, claimed); // atomic claim: concurrent drainers get ENOENT
    }
    catch {
        return [];
    }
    try {
        const raw = await fs.readFile(claimed, 'utf8');
        const events = [];
        for (const line of raw.split('\n')) {
            if (!line.trim())
                continue;
            try {
                events.push(JSON.parse(line));
            }
            catch {
                /* skip a torn line (interrupted append) */
            }
        }
        return events;
    }
    catch {
        return [];
    }
    finally {
        await fs.rm(claimed, { force: true }).catch(() => { });
    }
}
/**
 * Drain the spool and ship it as ONE batch blob. Returns the number of
 * events shipped (0 = nothing waiting). On a failed put the events go back
 * on the spool — at-most-once overall, but a transient backend error does
 * not eat the batch.
 */
export async function flushEvents(backend, busUri, agent) {
    const events = await drainSpool(busUri, agent);
    if (events.length === 0)
        return 0;
    const batch = { v: 1, events };
    const id = randomUUID().replace(/-/g, '').slice(0, 12);
    try {
        await backend.put(`${EVENTS_PREFIX}${eventSeq()}_${id}.json`, Buffer.from(JSON.stringify(batch), 'utf8'));
        return events.length;
    }
    catch (err) {
        await spoolEvents(busUri, agent, events);
        throw err;
    }
}
let _counter = 0;
/** Same zero-padded <ms>-<counter> shape as mailbox keys, so key order = time order. */
function eventSeq() {
    const ms = Date.now().toString().padStart(15, '0');
    const c = (_counter++ % 1_000_000).toString().padStart(6, '0');
    return `${ms}-${c}`;
}
/** Materialize a capture-time event from caller input. */
export function materializeEvent(input) {
    return {
        id: randomUUID().replace(/-/g, '').slice(0, 12),
        ts: new Date().toISOString(),
        agent: input.agent,
        ...(input.session ? { session: input.session } : {}),
        type: input.type,
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.ref !== undefined ? { ref: input.ref } : {}),
        ...(input.attrs !== undefined ? { attrs: input.attrs } : {}),
    };
}
/** ms timestamp from an events/ key's zero-padded seq prefix, or null. */
export function batchTimestamp(key) {
    const file = key.slice(key.lastIndexOf('/') + 1);
    const m = /^0*(\d+)-/.exec(file);
    return m ? Number(m[1]) : null;
}
/**
 * Read events, oldest→newest. Batch keys are seq-ordered so `sinceMs` prunes
 * whole blobs before any body is fetched (a batch's key time is its flush
 * time, always ≥ every capture time inside it); per-event filters apply
 * after parsing. Unreadable blobs are skipped, never fatal.
 */
export async function listEvents(backend, filter = {}) {
    const keys = (await backend.list(EVENTS_PREFIX)).filter((k) => k.endsWith('.json'));
    const out = [];
    for (const key of keys) {
        const batchTs = batchTimestamp(key);
        if (batchTs === null)
            continue;
        if (filter.sinceMs !== undefined && batchTs < filter.sinceMs)
            continue;
        let batch;
        try {
            batch = JSON.parse((await backend.get(key)).toString('utf8'));
        }
        catch {
            continue;
        }
        if (!Array.isArray(batch.events))
            continue;
        for (const e of batch.events) {
            if (filter.type && e.type !== filter.type)
                continue;
            if (filter.name && e.name !== filter.name)
                continue;
            if (filter.ref && e.ref !== filter.ref)
                continue;
            if (filter.agent && e.agent !== filter.agent)
                continue;
            if (filter.sinceMs !== undefined && (Date.parse(e.ts) || 0) < filter.sinceMs)
                continue;
            out.push(e);
        }
    }
    out.sort((a, b) => (Date.parse(a.ts) || 0) - (Date.parse(b.ts) || 0) || a.id.localeCompare(b.id));
    return out;
}
//# sourceMappingURL=telemetry.js.map