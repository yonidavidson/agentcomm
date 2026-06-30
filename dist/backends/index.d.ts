import type { Backend } from '../types.js';
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
export declare function createBackend(uri: string): Promise<Backend>;
//# sourceMappingURL=index.d.ts.map