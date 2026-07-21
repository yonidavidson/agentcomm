export type Harness = 'opencode' | 'claude' | 'codex';
/** Numeric semver-ish compare of dotted versions: >0 if a is newer than b. */
export declare function compareVersions(a: string, b: string): number;
/** Build the user-facing notice, or null if `latest` is not newer than `mine`. */
export declare function updateMessage(mine: string, latestTag: string, harness: Harness): string | null;
/** This package's installed version, read from its own package.json (dist/ is one level down). */
export declare function ownVersion(): string | null;
/** Latest release tag on GitHub, or null on any failure (offline, rate-limit, timeout). */
export declare function fetchLatestTag(timeoutMs?: number): Promise<string | null>;
/**
 * Returns an "update available" notice string, or null. Throttled to one network
 * check per day per harness via a temp-file cache; always fails open.
 */
export declare function updateNotice(harness: Harness): Promise<string | null>;
//# sourceMappingURL=update-check.d.ts.map