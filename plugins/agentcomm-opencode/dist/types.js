/**
 * Core types for agentcomm.
 *
 * The {@link Backend} interface is the seam the whole project is built around:
 * a tiny blob store (put/get/list/delete/exists/move) that every storage
 * engine implements. The Bus is written purely against this interface, so a
 * new transport is "just" a new Backend.
 *
 * Richer backends (SQL) may additionally implement the optional capability
 * interfaces {@link Claimable} and {@link Waitable}. The Bus feature-detects
 * these at runtime and falls back to the blob primitives when they are absent.
 */
export function isClaimable(b) {
    return typeof b.claim === 'function';
}
export function isWaitable(b) {
    return typeof b.waitPush === 'function';
}
/** Thrown when an optional driver (better-sqlite3, pg, aws/gcs sdk) is missing. */
export class MissingDriverError extends Error {
    constructor(pkg, forWhat) {
        super(`agentcomm: ${forWhat} requires the optional dependency "${pkg}", which is not installed.\n` +
            `Install it with:  npm install ${pkg}`);
        this.name = 'MissingDriverError';
    }
}
//# sourceMappingURL=types.js.map