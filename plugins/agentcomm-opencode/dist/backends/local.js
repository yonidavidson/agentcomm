import { promises as fs } from 'node:fs';
import * as path from 'node:path';
/**
 * Zero-dependency filesystem backend. Keys map directly to files under a
 * root directory. This is the default; it needs nothing installed.
 *
 * Atomicity:
 *  - `put` writes to a temp file then renames (atomic on POSIX/NTFS).
 *  - `move` uses rename (atomic within a filesystem).
 */
export class LocalBackend {
    root;
    constructor(root) {
        this.root = root;
    }
    full(key) {
        return path.join(this.root, key);
    }
    async put(key, data) {
        const target = this.full(key);
        await fs.mkdir(path.dirname(target), { recursive: true });
        // Unique temp name so concurrent writers to different keys never collide.
        const tmp = `${target}.tmp-${process.pid}-${counter()}`;
        await fs.writeFile(tmp, data);
        await fs.rename(tmp, target);
    }
    async get(key) {
        return fs.readFile(this.full(key));
    }
    async list(prefix) {
        // Walk the directory tree under root, return keys (relative, posix-style)
        // that start with `prefix`, sorted ascending.
        const keys = [];
        await this.walk(this.root, keys);
        const matched = keys.filter((k) => k.startsWith(prefix));
        matched.sort();
        return matched;
    }
    async walk(dir, out) {
        let entries;
        try {
            entries = await fs.readdir(dir, { withFileTypes: true });
        }
        catch (err) {
            if (err.code === 'ENOENT')
                return;
            throw err;
        }
        for (const entry of entries) {
            const abs = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                await this.walk(abs, out);
            }
            else if (entry.isFile()) {
                if (entry.name.includes('.tmp-'))
                    continue; // skip in-flight writes
                out.push(toKey(path.relative(this.root, abs)));
            }
        }
    }
    async delete(key) {
        try {
            await fs.unlink(this.full(key));
        }
        catch (err) {
            if (err.code === 'ENOENT')
                return;
            throw err;
        }
    }
    async exists(key) {
        try {
            await fs.access(this.full(key));
            return true;
        }
        catch {
            return false;
        }
    }
    async move(src, dst) {
        const from = this.full(src);
        const to = this.full(dst);
        await fs.mkdir(path.dirname(to), { recursive: true });
        await fs.rename(from, to);
    }
}
let _counter = 0;
function counter() {
    return _counter++;
}
/** Normalise a filesystem-relative path to a forward-slash key. */
function toKey(rel) {
    return rel.split(path.sep).join('/');
}
//# sourceMappingURL=local.js.map