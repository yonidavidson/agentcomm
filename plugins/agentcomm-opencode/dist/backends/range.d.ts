/**
 * Smallest key that is strictly greater than every key with `prefix`.
 * Increments the last byte; returns null if the prefix is empty or all 0xff
 * (in which case there is no upper bound and the caller scans to the end).
 *
 * Used by SQL backends to express "starts with `prefix`" as an index-range
 * scan (`key >= prefix AND key < upperBound(prefix)`) instead of `LIKE`.
 */
export declare function upperBound(prefix: string): string | null;
//# sourceMappingURL=range.d.ts.map