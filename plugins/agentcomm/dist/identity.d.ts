/**
 * A fingerprint of THIS session, stable across the many invocations one agent
 * session makes: AGENTCOMM_SESSION, else the terminal session id, else the
 * harness process (grandparent pid). Suffixes derived aliases and is recorded
 * in registrations, so tooling can tell "stale me" from "someone else".
 */
export declare function sessionHash(): Promise<string>;
/**
 * The honest default alias + its source, WITHOUT any stderr announce or memo —
 * callers (the CLI's resolveAgent, harness plugins) layer those on. Returns
 * `{ name: null }` only when neither a git identity nor an OS username exists.
 */
export declare function deriveIdentity(): Promise<{
    name: string | null;
    source: string;
}>;
//# sourceMappingURL=identity.d.ts.map