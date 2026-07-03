import * as path from 'node:path';
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

const registry = new Map<string, { factory: BackendFactory; info?: BackendInfo }>();

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
export function registerBackend(scheme: string, factory: BackendFactory, info?: BackendInfo): void {
  registry.set(scheme.toLowerCase(), { factory, info });
}

/** Currently registered URI schemes, sorted. */
export function registeredSchemes(): string[] {
  return [...registry.keys()].sort();
}

/**
 * The {@link BackendInfo} a scheme registered, or undefined for schemes that
 * registered without one (the CLI then tells the user to consult the
 * plugin's own docs). Throws the same unsupported-scheme error as
 * {@link createBackend} for schemes nobody registered.
 */
export function backendInfo(scheme: string): BackendInfo | undefined {
  const entry = registry.get(scheme.toLowerCase());
  if (!entry) {
    throw new Error(
      `agentcomm: unsupported backend scheme "${scheme}". ` +
        `Known schemes: ${registeredSchemes().join(', ')}. ` +
        `Third-party backends can add more via registerBackend() — see the README.`,
    );
  }
  return entry.info;
}

/**
 * Resolve the scheme a URI would be served by, applying the same bare-path
 * rules as {@link createBackend}: `*.db` → sqlite, any other bare path →
 * file. Purely syntactic — never touches the backend.
 */
export function schemeForUri(uri: string): string {
  const scheme = schemeOf(uri);
  if (scheme !== null) return scheme;
  return uri.endsWith('.db') ? 'sqlite' : 'file';
}

const FILE_INFO: BackendInfo = {
  kind: 'filesystem',
  capabilities: { claim: false, push: false },
  channel: {
    rule: 'Every directory is its own isolated channel — append a subdirectory to carve one.',
    template: 'file:///shared/bus/<channel>',
    example: 'file:///tmp/agentcomm/team-a',
  },
  notes: ['Zero dependencies — the default backend.', 'wait polls; single consumer per inbox.'],
};

const SQLITE_INFO: BackendInfo = {
  kind: 'sqlite',
  capabilities: { claim: true, push: false },
  channel: {
    rule: 'One channel per database file — use a different .db path per channel.',
    template: 'sqlite:///shared/bus/<channel>.db',
    example: 'sqlite:///tmp/agentcomm/team-a.db',
  },
  notes: [
    'Requires better-sqlite3 (npm install better-sqlite3).',
    'claim is atomic across processes (WAL).',
    'Keep the .db on a real local disk — not a network/object-mounted filesystem.',
  ],
};

const objectStoreInfo = (scheme: string, sdk: string): BackendInfo => ({
  kind: 'object-store',
  capabilities: { claim: false, push: false },
  channel: {
    rule: 'Every key prefix under the bucket is an isolated channel — append path segments to carve one (nesting is safe).',
    template: `${scheme}://<bucket>/<channel>`,
    example: `${scheme}://acme-bus/team-a`,
  },
  notes: [
    `Requires ${sdk} (npm install ${sdk}).`,
    'No claim — object-store moves are not atomic; give each consumer its own inbox.',
    'wait polls (no push).',
  ],
});

const POSTGRES_INFO: BackendInfo = {
  kind: 'postgres',
  capabilities: { claim: true, push: true },
  channel: {
    rule: 'One channel per database today — point at a different database per channel.',
    template: 'postgres://user:pass@host:5432/<database>',
    example: 'postgres://bus:pw@db.internal:5432/agentcomm_team_a',
  },
  notes: [
    'Requires pg (npm install pg).',
    'claim is atomic (FOR UPDATE SKIP LOCKED); wait is real push (LISTEN/NOTIFY).',
  ],
};

registerBackend('file', (uri) => Promise.resolve(new LocalBackend(filePath(uri))), FILE_INFO);
registerBackend('sqlite', (uri) => SqliteBackend.open(sqlitePath(uri)), SQLITE_INFO);
registerBackend(
  's3',
  (uri) => {
    const { bucket, prefix } = bucketAndPrefix(uri, 's3');
    return S3Backend.open(bucket, prefix);
  },
  objectStoreInfo('s3', '@aws-sdk/client-s3'),
);
registerBackend(
  'gs',
  (uri) => {
    const { bucket, prefix } = bucketAndPrefix(uri, 'gs');
    return GCSBackend.open(bucket, prefix);
  },
  objectStoreInfo('gs', '@google-cloud/storage'),
);
registerBackend('postgres', (uri) => PostgresBackend.open(uri), POSTGRES_INFO);
registerBackend('postgresql', (uri) => PostgresBackend.open(uri), POSTGRES_INFO);

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
export async function createBackend(uri: string): Promise<Backend> {
  const scheme = schemeOf(uri);

  if (scheme === null) {
    // No scheme → bare path. `.db` means SQLite; anything else is a directory.
    if (uri.endsWith('.db')) return SqliteBackend.open(path.resolve(uri));
    return new LocalBackend(path.resolve(uri));
  }

  const entry = registry.get(scheme);
  if (!entry) {
    throw new Error(
      `agentcomm: unsupported backend URI "${uri}". ` +
        `Known schemes: ${registeredSchemes().join(', ')}. ` +
        `Third-party backends can add more via registerBackend() — see the README.`,
    );
  }
  return entry.factory(uri);
}

function schemeOf(uri: string): string | null {
  const m = /^([a-zA-Z][a-zA-Z0-9+.-]*):\/\//.exec(uri);
  return m ? m[1]!.toLowerCase() : null;
}

function filePath(uri: string): string {
  // file:///abs → /abs ; file://rel → rel (relative to cwd)
  const rest = uri.slice('file://'.length);
  return path.resolve(rest);
}

function sqlitePath(uri: string): string {
  // sqlite:///abs/x.db → /abs/x.db ; sqlite://rel/x.db → rel/x.db
  const rest = uri.slice('sqlite://'.length);
  return path.resolve(rest);
}

function bucketAndPrefix(uri: string, scheme: string): { bucket: string; prefix: string } {
  const rest = uri.slice(`${scheme}://`.length);
  const slash = rest.indexOf('/');
  if (slash === -1) return { bucket: rest, prefix: '' };
  return { bucket: rest.slice(0, slash), prefix: rest.slice(slash + 1) };
}
