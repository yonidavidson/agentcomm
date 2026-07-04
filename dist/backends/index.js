import * as path from 'node:path';
import { LocalBackend } from './local.js';
import { SqliteBackend } from './sqlite.js';
import { S3Backend } from './s3.js';
import { GCSBackend } from './gcs.js';
import { PostgresBackend } from './postgres.js';
import { GithubBackend } from './github.js';
export { LocalBackend, SqliteBackend, S3Backend, GCSBackend, PostgresBackend, GithubBackend };
const registry = new Map();
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
export function registerBackend(scheme, factory, info) {
    registry.set(scheme.toLowerCase(), { factory, info });
}
/** Currently registered URI schemes, sorted. */
export function registeredSchemes() {
    return [...registry.keys()].sort();
}
/**
 * The {@link BackendInfo} a scheme registered, or undefined for schemes that
 * registered without one (the CLI then tells the user to consult the
 * plugin's own docs). Throws the same unsupported-scheme error as
 * {@link createBackend} for schemes nobody registered.
 */
export function backendInfo(scheme) {
    const entry = registry.get(scheme.toLowerCase());
    if (!entry) {
        throw new Error(`agentcomm: unsupported backend scheme "${scheme}". ` +
            `Known schemes: ${registeredSchemes().join(', ')}. ` +
            `Third-party backends can add more via registerBackend() — see the README.`);
    }
    return entry.info;
}
/**
 * Resolve the scheme a URI would be served by, applying the same bare-path
 * rules as {@link createBackend}: `*.db` → sqlite, any other bare path →
 * file. Purely syntactic — never touches the backend.
 */
export function schemeForUri(uri) {
    const scheme = schemeOf(uri);
    if (scheme !== null)
        return scheme;
    return uri.endsWith('.db') ? 'sqlite' : 'file';
}
const FILE_INFO = {
    kind: 'filesystem',
    capabilities: { claim: false, push: false },
    channel: {
        rule: 'Every directory is its own isolated channel — append a subdirectory to carve one.',
        template: 'file:///shared/bus/<channel>',
        example: 'file:///tmp/agentcomm/team-a',
    },
    notes: ['Zero dependencies — the default backend.', 'wait polls; single consumer per inbox.'],
};
const SQLITE_INFO = {
    kind: 'sqlite',
    capabilities: { claim: true, push: false },
    channel: {
        rule: 'Append ?channel=<name> to carve isolated channels from one database file (omitting it is the root channel). A different .db path per channel works too.',
        template: 'sqlite:///shared/bus.db?channel=<channel>',
        example: 'sqlite:///tmp/agentcomm/bus.db?channel=team-a',
    },
    notes: [
        'Requires better-sqlite3 (npm install better-sqlite3).',
        'claim is atomic across processes (WAL).',
        'Keep the .db on a real local disk — not a network/object-mounted filesystem.',
    ],
};
const objectStoreInfo = (scheme, sdk) => ({
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
const POSTGRES_INFO = {
    kind: 'postgres',
    capabilities: { claim: true, push: true },
    channel: {
        rule: 'Append ?channel=<name> to carve isolated channels from one database (omitting it is the root channel). Push and claim guarantees hold per channel.',
        template: 'postgres://user:pass@host:5432/db?channel=<channel>',
        example: 'postgres://bus:pw@db.internal:5432/agentcomm?channel=team-a',
    },
    notes: [
        'Requires pg (npm install pg).',
        'claim is atomic (FOR UPDATE SKIP LOCKED); wait is real push (LISTEN/NOTIFY).',
        'Other query params (e.g. sslmode) pass through to pg untouched.',
    ],
};
registerBackend('file', (uri) => {
    if (/[?&]channel=/.test(uri)) {
        throw new Error('agentcomm: file:// carves channels by path — append /<channel> to the directory instead of ?channel=.');
    }
    return Promise.resolve(new LocalBackend(filePath(uri)));
}, FILE_INFO);
registerBackend('sqlite', (uri) => {
    const { rest, channel } = splitChannelParam(uri.slice('sqlite://'.length));
    return SqliteBackend.open(path.resolve(rest), channel);
}, SQLITE_INFO);
registerBackend('s3', (uri) => {
    const { bucket, prefix } = bucketAndPrefix(uri, 's3');
    return S3Backend.open(bucket, prefix);
}, objectStoreInfo('s3', '@aws-sdk/client-s3'));
registerBackend('gs', (uri) => {
    const { bucket, prefix } = bucketAndPrefix(uri, 'gs');
    return GCSBackend.open(bucket, prefix);
}, objectStoreInfo('gs', '@google-cloud/storage'));
const GITHUB_INFO = {
    kind: 'github-repo',
    capabilities: { claim: false, push: false },
    channel: {
        rule: 'Every path prefix under the repo is an isolated channel — append segments to carve one (nesting is safe). ?branch=<name> selects a different bus branch (default: agentcomm).',
        template: 'github://<owner>/<repo>/<channel>',
        example: 'github://acme/webapp/team-a',
    },
    notes: [
        'Zero dependencies — token from AGENTCOMM_GITHUB_TOKEN, GITHUB_TOKEN, GH_TOKEN or `gh auth token`.',
        'No claim — moves are copy+commit, not atomic; give each consumer its own inbox.',
        'wait polls at a gentle ~3s cadence — the REST quota (5,000/hr) is shared account-wide.',
        'Every message is a commit: browse the bus branch on github.com to watch the conversation.',
        'The bus branch is disposable — delete it for a full reset (history included); it is recreated on the next write.',
    ],
};
registerBackend('github', (uri) => {
    const rest0 = uri.slice('github://'.length);
    const q = rest0.indexOf('?');
    let branch = 'agentcomm';
    const rest = q === -1 ? rest0 : rest0.slice(0, q);
    if (q !== -1) {
        const params = new URLSearchParams(rest0.slice(q + 1));
        if (params.has('channel')) {
            throw new Error('agentcomm: github:// carves channels by path — append /<channel> to the URI instead of ?channel=.');
        }
        branch = params.get('branch') ?? branch;
        params.delete('branch');
        const leftover = [...params.keys()];
        if (leftover.length > 0) {
            throw new Error(`agentcomm: unsupported query parameter(s) ${leftover.join(', ')} — only ?branch=<name> is recognized on github://.`);
        }
    }
    const segs = rest.split('/').filter(Boolean);
    if (segs.length < 2) {
        throw new Error('agentcomm: github:// needs at least owner/repo, e.g. github://acme/webapp[/channel]');
    }
    const [owner, repo, ...prefix] = segs;
    return GithubBackend.open(owner, repo, prefix.join('/'), branch);
}, GITHUB_INFO);
const postgresFactory = (uri) => {
    // Lift ONLY the channel param out of the URI; everything else (sslmode,
    // application_name, ...) must reach pg untouched.
    const url = new URL(uri);
    const channel = url.searchParams.get('channel') ?? '';
    if (channel)
        validateChannelName(channel);
    url.searchParams.delete('channel');
    return PostgresBackend.open(url.toString(), channel);
};
registerBackend('postgres', postgresFactory, POSTGRES_INFO);
registerBackend('postgresql', postgresFactory, POSTGRES_INFO);
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
    const entry = registry.get(scheme);
    if (!entry) {
        throw new Error(`agentcomm: unsupported backend URI "${uri}". ` +
            `Known schemes: ${registeredSchemes().join(', ')}. ` +
            `Third-party backends can add more via registerBackend() — see the README.`);
    }
    return entry.factory(uri);
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
/**
 * Split a `?channel=<name>` suffix (used by the SQL backends) off a URI
 * remainder, validating the name. Rejects any other query params — SQL paths
 * have no other meaningful ones, and silently eating typos would be worse.
 */
function splitChannelParam(rest) {
    const q = rest.indexOf('?');
    if (q === -1)
        return { rest, channel: '' };
    const params = new URLSearchParams(rest.slice(q + 1));
    const channel = params.get('channel') ?? '';
    params.delete('channel');
    const leftover = [...params.keys()];
    if (leftover.length > 0) {
        throw new Error(`agentcomm: unsupported query parameter(s) ${leftover.join(', ')} — only ?channel=<name> is recognized here.`);
    }
    if (channel)
        validateChannelName(channel);
    return { rest: rest.slice(0, q), channel };
}
function validateChannelName(name) {
    if (!/^[A-Za-z0-9._-]+$/.test(name)) {
        throw new Error(`agentcomm: invalid channel name "${name}". Use letters, digits, '.', '_' or '-'.`);
    }
}
function bucketAndPrefix(uri, scheme) {
    const rest = uri.slice(`${scheme}://`.length);
    const slash = rest.indexOf('/');
    if (slash === -1)
        return { bucket: rest, prefix: '' };
    return { bucket: rest.slice(0, slash), prefix: rest.slice(slash + 1) };
}
//# sourceMappingURL=index.js.map