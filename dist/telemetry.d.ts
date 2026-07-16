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
export declare const EVENTS_PREFIX = "events/";
/** A declarative capture rule from the repo config — if it's listed, it fires. */
export interface TelemetryTrackRule {
    /** Deterministic trigger: 'skill' | 'tool' | 'session' | 'task' | 'merge' (open vocabulary). */
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
export declare function spoolPath(busUri: string, agent: string): string;
/** Append events to the local spool. Never throws — capture is best-effort. */
export declare function spoolEvents(busUri: string, agent: string, events: TelemetryEvent[]): Promise<boolean>;
/** How many events are waiting locally for this bus, across all aliases (0 on any error). */
export declare function spoolDepth(busUri: string): Promise<number>;
/**
 * Drain every spool bound for this bus and ship them as ONE batch blob.
 * Returns the number of events shipped (0 = nothing waiting). On a failed
 * put the events go back on `respoolAgent`'s spool — at-most-once overall,
 * but a transient backend error does not eat the batch.
 */
export declare function flushEvents(backend: Backend, busUri: string, respoolAgent: string): Promise<number>;
/** Materialize a capture-time event from caller input. */
export declare function materializeEvent(input: {
    agent: string;
    type: string;
    session?: string;
    name?: string;
    ref?: string;
    attrs?: Record<string, unknown>;
}): TelemetryEvent;
export interface EventFilter {
    type?: string;
    name?: string;
    ref?: string;
    agent?: string;
    /** Only events captured at/after this ms timestamp. */
    sinceMs?: number;
}
/** ms timestamp from an events/ key's zero-padded seq prefix, or null. */
export declare function batchTimestamp(key: string): number | null;
/**
 * Read events, oldest→newest. Batch keys are seq-ordered so `sinceMs` prunes
 * whole blobs before any body is fetched (a batch's key time is its flush
 * time, always ≥ every capture time inside it); per-event filters apply
 * after parsing. Unreadable blobs are skipped, never fatal.
 */
export declare function listEvents(backend: Backend, filter?: EventFilter): Promise<TelemetryEvent[]>;
//# sourceMappingURL=telemetry.d.ts.map