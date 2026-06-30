import * as path from 'node:path';
import { LocalBackend } from './local.js';
import { SqliteBackend } from './sqlite.js';
import { S3Backend } from './s3.js';
import { GCSBackend } from './gcs.js';
import { PostgresBackend } from './postgres.js';
export { LocalBackend, SqliteBackend, S3Backend, GCSBackend, PostgresBackend };
const registry = new Map();
/**
 * Register a backend factory for a URI scheme, e.g. `registerBackend('redis',
 * factory)` enables `--backend redis://...`. This is the plugin seam: a
 * third-party package implementing {@link Backend} (optionally `Claimable`
 * and/or `Waitable`) calls this — typically as a side effect of being
 * imported — to add a new backend with no changes to agentcomm itself.
 *
 * The CLI loads such packages from `AGENTCOMM_BACKEND_PLUGINS` (a
 * comma/whitespace-separated list of module specifiers) before resolving
 * `--backend`. See "Writing a backend plugin" in the README.
 *
 * The four built-in backends are registered through this exact mechanism
 * below — there is no separate, more-privileged path for them.
 */
export function registerBackend(scheme, factory) {
    registry.set(scheme.toLowerCase(), factory);
}
/** Currently registered URI schemes, sorted. */
export function registeredSchemes() {
    return [...registry.keys()].sort();
}
registerBackend('file', (uri) => Promise.resolve(new LocalBackend(filePath(uri))));
registerBackend('sqlite', (uri) => SqliteBackend.open(sqlitePath(uri)));
registerBackend('s3', (uri) => {
    const { bucket, prefix } = bucketAndPrefix(uri, 's3');
    return S3Backend.open(bucket, prefix);
});
registerBackend('gs', (uri) => {
    const { bucket, prefix } = bucketAndPrefix(uri, 'gs');
    return GCSBackend.open(bucket, prefix);
});
registerBackend('postgres', (uri) => PostgresBackend.open(uri));
registerBackend('postgresql', (uri) => PostgresBackend.open(uri));
/**
 * Resolve a backend URI into a concrete {@link Backend}.
 *
 * Supported forms out of the box:
 *   file:///abs/path/dir        filesystem (LocalBackend)
 *   file://relative/dir         filesystem, relative to cwd
 *   /abs/path or ./rel          bare path → filesystem
 *   sqlite:///abs/path/to.db    single-file SQLite (SqliteBackend)
 *   *.db                        bare path ending in .db → SqliteBackend
 *   s3://bucket/optional/prefix S3 (lazy @aws-sdk/client-s3)
 *   gs://bucket/optional/prefix GCS (lazy @google-cloud/storage)
 *   postgres(ql)://...          Postgres (lazy pg)
 *
 * Plus any scheme registered via {@link registerBackend} (built-in or
 * third-party plugin).
 */
export async function createBackend(uri) {
    const scheme = schemeOf(uri);
    if (scheme === null) {
        // No scheme → bare path. `.db` means SQLite; anything else is a directory.
        if (uri.endsWith('.db'))
            return SqliteBackend.open(path.resolve(uri));
        return new LocalBackend(path.resolve(uri));
    }
    const factory = registry.get(scheme);
    if (!factory) {
        throw new Error(`agentcomm: unsupported backend URI "${uri}". ` +
            `Known schemes: ${registeredSchemes().join(', ')}. ` +
            `Third-party backends can add more via registerBackend() — see the README.`);
    }
    return factory(uri);
}
function schemeOf(uri) {
    const m = /^([a-zA-Z][a-zA-Z0-9+.-]*):\/\//.exec(uri);
    return m ? m[1].toLowerCase() : null;
}
function filePath(uri) {
    // file:///abs → /abs ; file://rel → rel (relative to cwd)
    const rest = uri.slice('file://'.length);
    return path.resolve(rest);
}
function sqlitePath(uri) {
    // sqlite:///abs/x.db → /abs/x.db ; sqlite://rel/x.db → rel/x.db
    const rest = uri.slice('sqlite://'.length);
    return path.resolve(rest);
}
function bucketAndPrefix(uri, scheme) {
    const rest = uri.slice(`${scheme}://`.length);
    const slash = rest.indexOf('/');
    if (slash === -1)
        return { bucket: rest, prefix: '' };
    return { bucket: rest.slice(0, slash), prefix: rest.slice(slash + 1) };
}
//# sourceMappingURL=index.js.map