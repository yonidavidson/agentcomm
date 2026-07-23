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
import type { Backend } from './types.js';

/** A telemetry event. `ts` is stamped at capture time, not flush time. */
export interface TelemetryEvent {
  id: string;
  /** ISO 8601 capture time. */
  ts: string;
  /** Bus alias of the emitting agent. */
  agent: string;
  /** Session fingerprint (same value registrations carry) — the join key to agents/. */
  session?: string;
  /** What happened: 'skill-ran' | 'skill-outcome' | 'session-start' | 'merged' | … (open vocabulary). */
  type: string;
  /** What it happened to: a skill, tool, or command name. */
  name?: string;
  /** Correlation handle: branch, PR number, thread id, run id. */
  ref?: string;
  /** Free-form structured payload — the queryable part ("found_bugs": true). */
  attrs?: Record<string, unknown>;
}

/** The stored blob shape: one flush = one batch. */
export interface EventBatch {
  v: 1;
  events: TelemetryEvent[];
}

export const EVENTS_PREFIX = 'events/';

/** A declarative capture rule from the repo config — if it's listed, it fires. */
export interface TelemetryTrackRule {
  /** Deterministic trigger: 'skill' | 'agent' | 'tool' | 'session' | 'task' | 'merge' (open vocabulary). */
  on: string;
  /** Optional name filter for the trigger (a skill name, a tool glob). */
  match?: string;
  /**
   * Optional free-text enrichment: what the AGENT should self-report about
   * this trigger via `agentcomm emit`. Injected as instructions by the
   * harness hooks; the deterministic layer never depends on it.
   */
  record?: string;
}

/**
 * The `telemetry` section of `.agentcomm.json`/`.yaml`. Its PRESENCE is the
 * opt-in: without it every telemetry code path is inert. `retention` is
 * keep-everything unless an explicit horizon is configured (see purge).
 */
export interface TelemetryConfig {
  track: TelemetryTrackRule[];
  /** 'none' (default) keeps everything; a duration ("180d") lets purge age events out. */
  retention?: string;
}

// ── spool ───────────────────────────────────────────────────────────────────
// Capture must be fast, offline, and unable to break the caller: append a
// JSONL line to a tmpdir file keyed by (bus URI, agent). The bus key is a
// separate filename segment so a flush can drain EVERY spool bound for this
// bus, not just the acting alias's — hook-captured events (derived session
// alias) still ship when the agent writes as a role alias, and each event
// carries its own `agent` field so cross-alias batches lose nothing.
// Draining claims a whole file with an atomic rename, so concurrent flushers
// never double-ship — the loser of the rename race finds nothing to drain.

const busKey = (busUri: string): string => createHash('sha1').update(busUri).digest('hex').slice(0, 12);
const spoolPrefix = (busUri: string): string => `agentcomm-events-${busKey(busUri)}-`;

export function spoolPath(busUri: string, agent: string): string {
  const agentKey = createHash('sha1').update(agent).digest('hex').slice(0, 12);
  return path.join(os.tmpdir(), `${spoolPrefix(busUri)}${agentKey}.jsonl`);
}

/** Every spool file currently waiting for this bus (any alias). */
async function spoolFiles(busUri: string): Promise<string[]> {
  try {
    const names = await fs.readdir(os.tmpdir());
    return names
      .filter((n) => n.startsWith(spoolPrefix(busUri)) && n.endsWith('.jsonl'))
      .map((n) => path.join(os.tmpdir(), n));
  } catch {
    return [];
  }
}

/** Append events to the local spool. Never throws — capture is best-effort. */
export async function spoolEvents(busUri: string, agent: string, events: TelemetryEvent[]): Promise<boolean> {
  if (events.length === 0) return true;
  try {
    const lines = events.map((e) => JSON.stringify(e)).join('\n') + '\n';
    await fs.appendFile(spoolPath(busUri, agent), lines, 'utf8');
    return true;
  } catch {
    return false;
  }
}

/** How many events are waiting locally for this bus, across all aliases (0 on any error). */
export async function spoolDepth(busUri: string): Promise<number> {
  let n = 0;
  for (const file of await spoolFiles(busUri)) {
    try {
      const raw = await fs.readFile(file, 'utf8');
      n += raw.split('\n').filter((l) => l.trim()).length;
    } catch {
      /* claimed or vanished mid-count */
    }
  }
  return n;
}

/** Atomically claim and parse one spool file. Empty array when nothing (or on a lost race). */
async function drainSpoolFile(file: string): Promise<TelemetryEvent[]> {
  const claimed = `${file}.${process.pid}.${randomUUID().slice(0, 8)}.draining`;
  try {
    await fs.rename(file, claimed); // atomic claim: concurrent drainers get ENOENT
  } catch {
    return [];
  }
  try {
    const raw = await fs.readFile(claimed, 'utf8');
    const events: TelemetryEvent[] = [];
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try {
        events.push(JSON.parse(line) as TelemetryEvent);
      } catch {
        /* skip a torn line (interrupted append) */
      }
    }
    return events;
  } catch {
    return [];
  } finally {
    await fs.rm(claimed, { force: true }).catch(() => {});
  }
}

/**
 * Drain every spool bound for this bus and ship them as ONE batch blob.
 * Returns the number of events shipped (0 = nothing waiting). On a failed
 * put the events go back on `respoolAgent`'s spool — at-most-once overall,
 * but a transient backend error does not eat the batch.
 */
export async function flushEvents(backend: Backend, busUri: string, respoolAgent: string): Promise<number> {
  let events: TelemetryEvent[] = [];
  for (const file of await spoolFiles(busUri)) events.push(...(await drainSpoolFile(file)));
  if (events.length === 0) return 0;
  events.sort((a, b) => (Date.parse(a.ts) || 0) - (Date.parse(b.ts) || 0) || a.id.localeCompare(b.id));
  events = dedupeEvents(events);
  const batch: EventBatch = { v: 1, events };
  const id = randomUUID().replace(/-/g, '').slice(0, 12);
  try {
    await backend.put(`${EVENTS_PREFIX}${eventSeq()}_${id}.json`, Buffer.from(JSON.stringify(batch), 'utf8'));
    return events.length;
  } catch (err) {
    await spoolEvents(busUri, respoolAgent, events);
    throw err;
  }
}

// ── dedup ───────────────────────────────────────────────────────────────────
// Harnesses can end up running the same hook more than once for a single
// underlying occurrence (the same hook command registered in more than one
// settings scope is the common case): each spawn derives the same event and
// emits it independently, so the store accumulates twins that differ only in
// their minted id/ts. Identity below is everything BUT id/ts; a repeat inside
// the window is the same occurrence, a repeat beyond it is a genuine re-run.

export const DEDUP_WINDOW_MS = 10_000;

/** JSON.stringify with object keys sorted at every depth, so equal attrs stringify equally. */
function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (typeof value === 'object' && value !== null) {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${stableJson(v)}`);
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/** Identity of an event minus its minted id/ts — re-derivations of one occurrence collide. */
export function eventDedupKey(e: TelemetryEvent): string {
  return stableJson([e.agent, e.session ?? null, e.type, e.name ?? null, e.ref ?? null, e.attrs ?? null]);
}

/**
 * Collapse events whose identity already appeared within `windowMs` of the
 * last KEPT twin. Input must be ts-sorted (both call sites sort first);
 * keep-first, so a burst of N twins collapses to the earliest one.
 */
export function dedupeEvents(events: TelemetryEvent[], windowMs = DEDUP_WINDOW_MS): TelemetryEvent[] {
  const lastKept = new Map<string, number>();
  const out: TelemetryEvent[] = [];
  for (const e of events) {
    const key = eventDedupKey(e);
    const ts = Date.parse(e.ts) || 0;
    const prev = lastKept.get(key);
    if (prev !== undefined && ts - prev < windowMs) continue;
    lastKept.set(key, ts);
    out.push(e);
  }
  return out;
}

let _counter = 0;
/** Same zero-padded <ms>-<counter> shape as mailbox keys, so key order = time order. */
function eventSeq(): string {
  const ms = Date.now().toString().padStart(15, '0');
  const c = (_counter++ % 1_000_000).toString().padStart(6, '0');
  return `${ms}-${c}`;
}

/** Materialize a capture-time event from caller input. */
export function materializeEvent(input: {
  agent: string;
  type: string;
  session?: string;
  name?: string;
  ref?: string;
  attrs?: Record<string, unknown>;
}): TelemetryEvent {
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

// ── reading ─────────────────────────────────────────────────────────────────

export interface EventFilter {
  type?: string;
  name?: string;
  ref?: string;
  agent?: string;
  /** Only events captured at/after this ms timestamp. */
  sinceMs?: number;
}

/** ms timestamp from an events/ key's zero-padded seq prefix, or null. */
export function batchTimestamp(key: string): number | null {
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
export async function listEvents(backend: Backend, filter: EventFilter = {}): Promise<TelemetryEvent[]> {
  const keys = (await backend.list(EVENTS_PREFIX)).filter((k) => k.endsWith('.json'));
  const out: TelemetryEvent[] = [];
  for (const key of keys) {
    const batchTs = batchTimestamp(key);
    if (batchTs === null) continue;
    if (filter.sinceMs !== undefined && batchTs < filter.sinceMs) continue;
    let batch: EventBatch;
    try {
      batch = JSON.parse((await backend.get(key)).toString('utf8')) as EventBatch;
    } catch {
      continue;
    }
    if (!Array.isArray(batch.events)) continue;
    for (const e of batch.events) {
      if (filter.type && e.type !== filter.type) continue;
      if (filter.name && e.name !== filter.name) continue;
      if (filter.ref && e.ref !== filter.ref) continue;
      if (filter.agent && e.agent !== filter.agent) continue;
      if (filter.sinceMs !== undefined && (Date.parse(e.ts) || 0) < filter.sinceMs) continue;
      out.push(e);
    }
  }
  out.sort((a, b) => (Date.parse(a.ts) || 0) - (Date.parse(b.ts) || 0) || a.id.localeCompare(b.id));
  // Read-time dedup is authoritative: it also collapses twins that landed in
  // DIFFERENT batches (two hook spawns racing a flush), which write-time
  // dedup inside one batch cannot see — and it heals stores written before
  // dedup existed.
  return dedupeEvents(out);
}
