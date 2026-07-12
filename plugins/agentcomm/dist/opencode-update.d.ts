/** Numeric semver-ish compare of dotted versions: >0 if a is newer than b. */
export declare function compareVersions(a: string, b: string): number;
/** Build the user-facing notice, or null if `latest` is not newer than `mine`. */
export declare function updateMessage(mine: string, latestTag: string): string | null;
/**
 * Returns an "update available" notice string, or null. Throttled to one network
 * check per day via a temp-file cache; always fails open.
 */
export declare function updateNotice(): Promise<string | null>;
//# sourceMappingURL=opencode-update.d.ts.map