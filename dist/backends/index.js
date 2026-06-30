import * as path from 'node:path';
import { LocalBackend } from './local.js';
import { SqliteBackend } from './sqlite.js';
import { S3Backend } from './s3.js';
import { GCSBackend } from './gcs.js';
export { LocalBackend, SqliteBackend, S3Backend, GCSBackend };
/**
 * Resolve a backend URI into a concrete {@link Backend}.
 *
 * Supported forms:
 *   file:///abs/path/dir        filesystem (LocalBackend)
 *   file://relative/dir         filesystem, relative to cwd
 *   /abs/path or ./rel          bare path → filesystem
 *   sqlite:///abs/path/to.db    single-file SQLite (SqliteBackend)
 *   *.db                        bare path ending in .db → SqliteBackend
 *   s3://bucket/optional/prefix S3 (lazy @aws-sdk/client-s3)
 *   gs://bucket/optional/prefix GCS (lazy @google-cloud/storage)
 */
export async function createBackend(uri) {
    const scheme = schemeOf(uri);
    switch (scheme) {
        case 'sqlite':
            return SqliteBackend.open(sqlitePath(uri));
        case 'file':
            return new LocalBackend(filePath(uri));
        case 's3': {
            const { bucket, prefix } = bucketAndPrefix(uri, 's3');
            return S3Backend.open(bucket, prefix);
        }
        case 'gs': {
            const { bucket, prefix } = bucketAndPrefix(uri, 'gs');
            return GCSBackend.open(bucket, prefix);
        }
        case null: {
            // No scheme → bare path. `.db` means SQLite; anything else is a directory.
            if (uri.endsWith('.db'))
                return SqliteBackend.open(path.resolve(uri));
            return new LocalBackend(path.resolve(uri));
        }
        default:
            throw new Error(`agentcomm: unsupported backend URI "${uri}". ` +
                `Use file://, sqlite://, s3://, gs:// or a bare path.`);
    }
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