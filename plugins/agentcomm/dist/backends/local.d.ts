import type { Backend } from '../types.js';
/**
 * Zero-dependency filesystem backend. Keys map directly to files under a
 * root directory. This is the default; it needs nothing installed.
 *
 * Atomicity:
 *  - `put` writes to a temp file then renames (atomic on POSIX/NTFS).
 *  - `move` uses rename (atomic within a filesystem).
 */
export declare class LocalBackend implements Backend {
    private readonly root;
    constructor(root: string);
    private full;
    put(key: string, data: Buffer): Promise<void>;
    get(key: string): Promise<Buffer>;
    list(prefix: string): Promise<string[]>;
    private walk;
    delete(key: string): Promise<void>;
    exists(key: string): Promise<boolean>;
    move(src: string, dst: string): Promise<void>;
}
//# sourceMappingURL=local.d.ts.map