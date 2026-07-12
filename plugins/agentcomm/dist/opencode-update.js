/**
 * OpenCode update check — the "Update Available" nudge (like omp/pi show).
 *
 * OpenCode installs the plugin from a versioned release tarball and caches it by
 * URL forever (a stable "latest" URL would NOT re-fetch — verified), so users
 * upgrade by bumping the version in their opencode.json. To make that visible,
 * the plugin compares its installed version to the latest GitHub release once a
 * day and, when behind, surfaces a one-line notice telling the user to bump the
 * URL. Everything fails open and is network-capped — never blocks a session.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as os from 'node:os';
import * as path from 'node:path';
const REPO = 'yonidavidson/agentcomm';
const CACHE = path.join(os.tmpdir(), 'agentcomm-opencode-update.json');
const DAY_MS = 24 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 1500;
/** Numeric semver-ish compare of dotted versions: >0 if a is newer than b. */
export function compareVersions(a, b) {
    const pa = a.replace(/^v/, '').split('.').map((n) => parseInt(n, 10) || 0);
    const pb = b.replace(/^v/, '').split('.').map((n) => parseInt(n, 10) || 0);
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
        const d = (pa[i] ?? 0) - (pb[i] ?? 0);
        if (d !== 0)
            return d > 0 ? 1 : -1;
    }
    return 0;
}
/** Build the user-facing notice, or null if `latest` is not newer than `mine`. */
export function updateMessage(mine, latestTag) {
    if (compareVersions(latestTag, mine) <= 0)
        return null;
    return (`agentcomm-opencode update available: v${mine.replace(/^v/, '')} → ${latestTag}. ` +
        `Bump the plugin tarball URL in your opencode.json to ${latestTag} ` +
        `(latest: https://github.com/${REPO}/releases/latest). OpenCode caches by URL, so ` +
        `the version in the URL is what triggers the upgrade.`);
}
/** This package's installed version, read from its own package.json (dist/ is one level down). */
function ownVersion() {
    try {
        const here = path.dirname(fileURLToPath(import.meta.url)); // <pkg>/dist
        const pkg = JSON.parse(readFileSync(path.join(here, '..', 'package.json'), 'utf8'));
        return typeof pkg.version === 'string' ? pkg.version : null;
    }
    catch {
        return null;
    }
}
async function fetchLatestTag() {
    try {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
        const res = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
            headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'agentcomm-opencode' },
            signal: ctrl.signal,
        });
        clearTimeout(timer);
        if (!res.ok)
            return null;
        const body = (await res.json());
        return typeof body.tag_name === 'string' ? body.tag_name : null;
    }
    catch {
        return null;
    }
}
/**
 * Returns an "update available" notice string, or null. Throttled to one network
 * check per day via a temp-file cache; always fails open.
 */
export async function updateNotice() {
    const mine = ownVersion();
    if (!mine)
        return null;
    // Day-throttle: reuse a recent result rather than hitting GitHub every session.
    try {
        const c = JSON.parse(readFileSync(CACHE, 'utf8'));
        if (typeof c.at === 'number' && Date.now() - c.at < DAY_MS) {
            return c.forVersion === mine ? (c.notice ?? null) : null;
        }
    }
    catch {
        /* no/invalid cache — fall through to a fresh check */
    }
    const tag = await fetchLatestTag();
    const notice = tag ? updateMessage(mine, tag) : null;
    try {
        writeFileSync(CACHE, JSON.stringify({ at: Date.now(), forVersion: mine, notice }));
    }
    catch {
        /* best effort */
    }
    return notice;
}
//# sourceMappingURL=opencode-update.js.map