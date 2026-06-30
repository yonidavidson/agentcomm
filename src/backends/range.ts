/**
 * Smallest key that is strictly greater than every key with `prefix`.
 * Increments the last byte; returns null if the prefix is empty or all 0xff
 * (in which case there is no upper bound and the caller scans to the end).
 *
 * Used by SQL backends to express "starts with `prefix`" as an index-range
 * scan (`key >= prefix AND key < upperBound(prefix)`) instead of `LIKE`.
 */
export function upperBound(prefix: string): string | null {
  if (prefix.length === 0) return null;
  const bytes = Buffer.from(prefix, 'utf8');
  for (let i = bytes.length - 1; i >= 0; i--) {
    if (bytes[i]! < 0xff) {
      const head = bytes.subarray(0, i + 1);
      head[i]! += 1;
      return head.toString('utf8');
    }
  }
  return null;
}
