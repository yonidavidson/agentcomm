import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { promisify } from 'node:util';
import { resolveGithubToken } from './github.js';
const execFileP = promisify(execFile);
/**
 * The "already on the network" default, generic-git first: inside a git work
 * tree, if git can ALREADY reach the `origin` remote (bounded `ls-remote`
 * probe with BatchMode ssh), the bus is `git+<origin>` — any host, git's own
 * auth, atomic `claim`. Only when that fails and the origin is github.com
 * with a resolvable token does the REST `github://` variant kick in (token-
 * only environments like CI). Anything else → null, restoring the classic
 * `file://./.agentcomm` default. Explicit choices (flag/env/config file)
 * are handled by the caller and always win. `AGENTCOMM_NO_GIT_PROBE=1`
 * skips the network probe.
 */
export async function detectRepoBus(cwd = process.cwd()) {
    let originUrl;
    try {
        const inTree = await execFileP('git', ['-C', cwd, 'rev-parse', '--is-inside-work-tree']);
        if (inTree.stdout.trim() !== 'true')
            return null;
        originUrl = (await execFileP('git', ['-C', cwd, 'remote', 'get-url', 'origin'])).stdout.trim();
    }
    catch {
        return null; // no git, not a repo, or no origin remote
    }
    const normalized = normalizeOrigin(originUrl);
    if (normalized && process.env.AGENTCOMM_NO_GIT_PROBE !== '1') {
        // The reachability probe is a network round-trip — pay it once per
        // origin per TTL, not on every CLI invocation. A stale verdict only
        // picks the transport; real connectivity failures still surface at
        // the first fetch with git's own error.
        const cached = await probeCacheRead(normalized.remote);
        if (cached !== null) {
            if (cached)
                return normalized.uri;
            // cached "unreachable" → fall through to the token path below
        }
        else {
            try {
                await execFileP('git', ['ls-remote', normalized.remote, 'HEAD'], {
                    timeout: 8000,
                    env: {
                        ...process.env,
                        GIT_TERMINAL_PROMPT: '0',
                        GIT_SSH_COMMAND: 'ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new -o ConnectTimeout=4',
                    },
                });
                await probeCacheWrite(normalized.remote, true);
                return normalized.uri; // git can reach it → the generic bus works, claim included
            }
            catch {
                await probeCacheWrite(normalized.remote, false);
                // fall through — maybe a token-only environment
            }
        }
    }
    const m = /github\.com[:/]([^/\s]+)\/([^/\s]+?)(?:\.git)?$/.exec(originUrl);
    if (!m)
        return null;
    try {
        await resolveGithubToken();
    }
    catch {
        return null;
    }
    return `github://${m[1]}/${m[2]}`;
}
const PROBE_TTL_MS = Number(process.env.AGENTCOMM_PROBE_TTL_MS ?? 15 * 60_000);
function probeCachePath(remote) {
    const dir = process.env.AGENTCOMM_DAEMON_DIR ?? path.join(os.homedir(), '.cache', 'agentcomm', 'd');
    return path.join(dir, 'probe-' + createHash('sha1').update(remote).digest('hex').slice(0, 12));
}
/** null = no fresh verdict; true/false = cached reachability. */
async function probeCacheRead(remote) {
    if (PROBE_TTL_MS <= 0)
        return null;
    try {
        const p = probeCachePath(remote);
        const st = await fs.stat(p);
        if (Date.now() - st.mtimeMs > PROBE_TTL_MS)
            return null;
        return (await fs.readFile(p, 'utf8')).trim() === '1';
    }
    catch {
        return null;
    }
}
async function probeCacheWrite(remote, reachable) {
    try {
        const p = probeCachePath(remote);
        await fs.mkdir(path.dirname(p), { recursive: true });
        await fs.writeFile(p, reachable ? '1' : '0');
    }
    catch {
        /* cache is best-effort */
    }
}
/** origin URL (any git form) → a probe-able remote + its git+ backend URI. */
function normalizeOrigin(url) {
    const scp = /^([^@\s/]+@[^:/\s]+):(?!\/)(.+)$/.exec(url); // git@host:path → ssh://host/path
    if (scp) {
        const remote = `ssh://${scp[1]}/${scp[2]}`;
        return { remote, uri: `git+${remote}` };
    }
    if (/^(ssh|https?|file):\/\//.test(url))
        return { remote: url, uri: `git+${url}` };
    if (url.startsWith('/'))
        return { remote: url, uri: `git+file://${url}` };
    return null;
}
//# sourceMappingURL=autodetect.js.map