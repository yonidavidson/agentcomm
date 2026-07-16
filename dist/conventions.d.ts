import type { TelemetryConfig } from './telemetry.js';
/**
 * Team conventions — the social contract on top of channels, so "work on x"
 * maps to the same channel URI for every agent without out-of-band knowledge.
 * Defaults live here in code; a project overrides them with an
 * `.agentcomm.json` (zero-dep) or `.agentcomm.yaml`/`.yml` (lazy optional
 * `yaml` package) file found upward from the working directory, or at
 * `AGENTCOMM_CONFIG`. Served by `agentcomm conventions`.
 */
export interface Conventions {
    /** Well-known meeting-room channel: register, announce, ask "who's on what". */
    lobby: string;
    /** How topic channels are named ("work on x" → channel `x` in this style). */
    topicStyle: string;
    /** Channel-name templates bound to repo artifacts (git backends). */
    artifactChannels: {
        issue: string;
        pr: string;
    };
    /** The shared subject vocabulary for message triage. */
    subjects: string[];
}
export declare const DEFAULT_CONVENTIONS: Conventions;
export interface LoadedConfig {
    conventions: Conventions;
    /** Optional default backend URI a project can pin in its config file. */
    backend?: string;
    /**
     * Telemetry capture config (issue #100). PRESENCE is the opt-in — when the
     * config file has no `telemetry` section this stays undefined and every
     * telemetry code path (emit, hook capture) is inert.
     */
    telemetry?: TelemetryConfig;
    /** Absolute path of the override file, or null when running on defaults. */
    source: string | null;
}
/**
 * Load conventions: built-in defaults, overridden (shallow per section) by
 * the nearest config file. `AGENTCOMM_CONFIG` names a file explicitly (an
 * error if unreadable); otherwise the filenames above are searched from
 * `cwd` upward.
 */
export declare function loadConventions(cwd?: string, env?: NodeJS.ProcessEnv): Promise<LoadedConfig>;
//# sourceMappingURL=conventions.d.ts.map