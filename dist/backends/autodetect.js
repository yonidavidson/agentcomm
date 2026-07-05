import { execFile } from 'node:child_process';
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
        try {
            await execFileP('git', ['ls-remote', normalized.remote, 'HEAD'], {
                timeout: 8000,
                env: {
                    ...process.env,
                    GIT_TERMINAL_PROMPT: '0',
                    GIT_SSH_COMMAND: 'ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new -o ConnectTimeout=4',
                },
            });
            return normalized.uri; // git can reach it → the generic bus works, claim included
        }
        catch {
            // fall through — maybe a token-only environment
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