import type { Backend } from '../types.js';
import { LocalBackend } from './local.js';
import { SqliteBackend } from './sqlite.js';
import { S3Backend } from './s3.js';
import { GCSBackend } from './gcs.js';
import { PostgresBackend } from './postgres.js';
export { LocalBackend, SqliteBackend, S3Backend, GCSBackend, PostgresBackend };
/** Builds a {@link Backend} from a full backend URI (including its scheme). */
export type BackendFactory = (uri: string) => Promise<Backend>;
/**
 * Static self-description of a backend scheme — everything an agent needs to
 * know *before* it can (or wants to) connect: how channels are carved from a
 * connection string, and what the backend can do. Served by `agentcomm
 * describe` with no driver loaded, no credentials, and no connection.
 */
export interface BackendInfo {
    /** Storage family, e.g. 'filesystem' | 'sqlite' | 'object-store' | 'postgres'. */
    kind: string;
    /** Static capability truth for this backend — not probed at runtime. */
    capabilities: {
        /** Atomic shared-queue dequeue (`claim`). */
        claim: boolean;
        /** Push-driven `wait` (resolves on arrival instead of polling). */
        push: boolean;
    };
    /** How a channel — one isolated bus — is carved from a connection string. */
    channel: {
        rule: string;
        template: string;
        example: string;
    };
    notes?: string[];
}
/**
 * Register a backend factory for a URI scheme, e.g. `registerBackend('redis',
 * factory)` enables `--backend redis://...`. This is the plugin seam: a
 * third-party package implementing {@link Backend} (optionally `Claimable`
 * and/or `Waitable`) calls this — typically as a side effect of being
 * imported — to add a new backend with no changes to agentcomm itself.
 *
 * Pass a {@link BackendInfo} as the third argument to make the scheme
 * self-describing via `agentcomm describe` — how to carve channels, and
 * which capabilities the backend has. Optional but strongly recommended.
 *
 * The CLI loads such packages from `AGENTCOMM_BACKEND_PLUGINS` (a
 * comma/whitespace-separated list of module specifiers) before resolving
 * `--backend`. See "Writing a backend plugin" in the README.
 *
 * The four built-in backends are registered through this exact mechanism
 * below — there is no separate, more-privileged path for them.
 */
export declare function registerBackend(scheme: string, factory: BackendFactory, info?: BackendInfo): void;
/** Currently registered URI schemes, sorted. */
export declare function registeredSchemes(): string[];
/**
 * The {@link BackendInfo} a scheme registered, or undefined for schemes that
 * registered without one (the CLI then tells the user to consult the
 * plugin's own docs). Throws the same unsupported-scheme error as
 * {@link createBackend} for schemes nobody registered.
 */
export declare function backendInfo(scheme: string): BackendInfo | undefined;
/**
 * Resolve the scheme a URI would be served by, applying the same bare-path
 * rules as {@link createBackend}: `*.db` → sqlite, any other bare path →
 * file. Purely syntactic — never touches the backend.
 */
export declare function schemeForUri(uri: string): string;
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
export declare function createBackend(uri: string): Promise<Backend>;
//# sourceMappingURL=index.d.ts.map