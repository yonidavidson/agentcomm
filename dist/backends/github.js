import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const execFileP = promisify(execFile);
/**
 * GithubBackend — the repo itself is the store. Keys are files on a dedicated
 * (orphan) branch, written through the GitHub REST contents API; every
 * message is a commit, so the whole bus is browsable in the web UI and repo
 * collaborator permissions are the access control.
 *
 * ZERO npm dependencies: global fetch (node >= 18) plus a token resolved from
 * AGENTCOMM_GITHUB_TOKEN → GITHUB_TOKEN → GH_TOKEN → `gh auth token`.
 *
 * Like the object stores, `move` is copy+delete (NOT atomic) — no `claim`;
 * give each consumer its own inbox. Concurrent commits to one branch race on
 * the ref update; writes retry with a fresh sha a bounded number of times.
 * This backend is sized for conversation-volume traffic (the REST quota is
 * 5,000 calls/hour shared account-wide) — poll gently.
 */
export class GithubBackend {
    owner;
    repo;
    branch;
    basePrefix;
    token;
    constructor(owner, repo, branch, basePrefix, token) {
        this.owner = owner;
        this.repo = repo;
        this.branch = branch;
        this.basePrefix = basePrefix;
        this.token = token;
    }
    static async open(owner, repo, basePrefix = '', branch = 'agentcomm') {
        const token = await resolveGithubToken();
        const prefix = basePrefix && !basePrefix.endsWith('/') ? `${basePrefix}/` : basePrefix;
        return new GithubBackend(owner, repo, branch, prefix, token);
    }
    k(key) {
        return this.basePrefix + key;
    }
    // GitHub API GETs are cached; a read right after a write can serve stale
    // data (a deleted file still "existing", a tree missing a fresh commit).
    // A unique throwaway query param forces a fresh response.
    static cacheBust = 0;
    bust() {
        return `cb=${Date.now().toString(36)}${(GithubBackend.cacheBust++).toString(36)}`;
    }
    contentsUrl(key) {
        const path = this.k(key).split('/').map(encodeURIComponent).join('/');
        return `/repos/${this.owner}/${this.repo}/contents/${path}`;
    }
    async api(method, url, body, accept = 'application/vnd.github+json') {
        const res = await fetch(`https://api.github.com${url}`, {
            method,
            headers: {
                Authorization: `Bearer ${this.token}`,
                Accept: accept,
                'X-GitHub-Api-Version': '2022-11-28',
                'User-Agent': 'agentcomm',
                ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
            },
            body: body !== undefined ? JSON.stringify(body) : undefined,
        });
        if (res.status === 403 || res.status === 429) {
            if (res.headers.get('x-ratelimit-remaining') === '0') {
                const reset = Number(res.headers.get('x-ratelimit-reset') ?? 0) * 1000;
                const mins = reset ? Math.max(0, Math.ceil((reset - Date.now()) / 60000)) : '?';
                res.body?.cancel().catch(() => { });
                throw new Error(`agentcomm: GitHub API rate limit exhausted (shared 5,000/hr) — resets in ~${mins} min. ` +
                    'This backend is for conversation-volume traffic; poll gently.');
            }
        }
        return res;
    }
    /**
     * Current tip commit of the bus branch (null when the branch doesn't exist
     * yet). Reads pin themselves to this immutable sha: reading contents by
     * branch NAME can lag a just-made commit (server-side replication), while
     * the cache-busted ref lookup is fresh — so ref-then-sha is how every read
     * stays read-your-write consistent.
     */
    async tip() {
        const res = await this.api('GET', `/repos/${this.owner}/${this.repo}/git/ref/${encodeURIComponent(`heads/${this.branch}`)}?${this.bust()}`);
        if (res.status === 404) {
            res.body?.cancel().catch(() => { });
            return null;
        }
        if (!res.ok)
            throw await apiError(res, `resolve branch ${this.branch}`);
        return (await res.json()).object.sha;
    }
    /** Current blob sha of a key on the bus branch, or null when absent. */
    async shaOf(key, atTip) {
        const tip = atTip !== undefined ? atTip : await this.tip();
        if (tip === null)
            return null;
        const res = await this.api('GET', `${this.contentsUrl(key)}?ref=${tip}`);
        if (res.status === 404) {
            res.body?.cancel().catch(() => { });
            return null;
        }
        if (!res.ok)
            throw await apiError(res, `stat ${key}`);
        const json = (await res.json());
        return json.sha;
    }
    async put(key, data) {
        // Contents-API upsert. Two race classes handled by the retry loop:
        // 409/422 on a stale-or-missing sha (someone else committed between our
        // stat and our write), and 404 branch-not-found on the very first write
        // (the orphan bus branch doesn't exist yet — created via the git data
        // API; if two agents race to create it, the loser falls back to a plain
        // contents write on the next attempt).
        let sha = await this.shaOf(key);
        for (let attempt = 1;; attempt++) {
            const res = await this.api('PUT', this.contentsUrl(key), {
                message: `agentcomm: put ${this.k(key)}`,
                content: data.toString('base64'),
                branch: this.branch,
                ...(sha ? { sha } : {}),
            });
            if (res.ok) {
                res.body?.cancel().catch(() => { });
                return;
            }
            if (res.status === 404) {
                res.body?.cancel().catch(() => { });
                if (await this.createOrphanBranch(key, data))
                    return;
                // branch appeared concurrently — retry the contents write
            }
            else if (res.status === 409 || res.status === 422) {
                res.body?.cancel().catch(() => { });
            }
            else {
                throw await apiError(res, `put ${key}`);
            }
            if (attempt >= 5)
                throw new Error(`agentcomm: github put ${key} kept conflicting after ${attempt} attempts`);
            await sleep(50 * attempt + Math.floor(Math.random() * 100));
            sha = await this.shaOf(key);
        }
    }
    /**
     * First write: create the bus branch as an ORPHAN ref (parentless commit)
     * carrying this one file. Returns false if another agent created the
     * branch first (caller retries via the contents API).
     */
    async createOrphanBranch(key, data) {
        const base = `/repos/${this.owner}/${this.repo}/git`;
        const blob = await this.api('POST', `${base}/blobs`, { content: data.toString('base64'), encoding: 'base64' });
        if (!blob.ok)
            throw await apiError(blob, `create blob for ${key}`);
        const blobSha = (await blob.json()).sha;
        const tree = await this.api('POST', `${base}/trees`, {
            tree: [{ path: this.k(key), mode: '100644', type: 'blob', sha: blobSha }],
        });
        if (!tree.ok)
            throw await apiError(tree, `create tree for ${key}`);
        const treeSha = (await tree.json()).sha;
        const commit = await this.api('POST', `${base}/commits`, {
            message: `agentcomm: initialize bus branch (put ${this.k(key)})`,
            tree: treeSha,
            parents: [],
        });
        if (!commit.ok)
            throw await apiError(commit, `create commit for ${key}`);
        const commitSha = (await commit.json()).sha;
        const ref = await this.api('POST', `${base}/refs`, {
            ref: `refs/heads/${this.branch}`,
            sha: commitSha,
        });
        if (ref.status === 422) {
            // Lost the creation race — branch now exists.
            ref.body?.cancel().catch(() => { });
            return false;
        }
        if (!ref.ok)
            throw await apiError(ref, `create branch ${this.branch}`);
        ref.body?.cancel().catch(() => { });
        return true;
    }
    async get(key) {
        const tip = await this.tip();
        if (tip === null)
            throw notFound(key);
        const res = await this.api('GET', `${this.contentsUrl(key)}?ref=${tip}`, undefined, 'application/vnd.github.raw+json');
        if (res.status === 404) {
            res.body?.cancel().catch(() => { });
            throw notFound(key);
        }
        if (!res.ok)
            throw await apiError(res, `get ${key}`);
        return Buffer.from(await res.arrayBuffer());
    }
    async list(prefix) {
        const tip = await this.tip();
        if (tip === null)
            return []; // no bus branch yet — an empty store, not an error
        const res = await this.api('GET', `/repos/${this.owner}/${this.repo}/git/trees/${tip}?recursive=1`);
        if (!res.ok)
            throw await apiError(res, `list ${prefix}`);
        const json = (await res.json());
        const full = this.k(prefix);
        return json.tree
            .filter((e) => e.type === 'blob' && e.path.startsWith(full))
            .map((e) => e.path.slice(this.basePrefix.length))
            .sort();
    }
    async delete(key) {
        for (let attempt = 1;; attempt++) {
            const sha = await this.shaOf(key);
            if (sha === null)
                return; // absent → no-op, per the Backend contract
            const res = await this.api('DELETE', this.contentsUrl(key), {
                message: `agentcomm: delete ${this.k(key)}`,
                sha,
                branch: this.branch,
            });
            if (res.ok || res.status === 404) {
                res.body?.cancel().catch(() => { });
                return;
            }
            if ((res.status === 409 || res.status === 422) && attempt < 5) {
                res.body?.cancel().catch(() => { });
                await sleep(50 * attempt + Math.floor(Math.random() * 100));
                continue;
            }
            throw await apiError(res, `delete ${key}`);
        }
    }
    async exists(key) {
        return (await this.shaOf(key)) !== null;
    }
    async move(src, dst) {
        // copy + delete — NOT atomic. Same rule as the object stores: no claim.
        const data = await this.get(src);
        await this.put(dst, data);
        await this.delete(src);
    }
}
/**
 * Token discovery for the github backend, in priority order:
 * AGENTCOMM_GITHUB_TOKEN → GITHUB_TOKEN → GH_TOKEN → `gh auth token`.
 * Exported for reuse (tests, tooling).
 */
export async function resolveGithubToken() {
    const fromEnv = process.env.AGENTCOMM_GITHUB_TOKEN || process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
    if (fromEnv)
        return fromEnv;
    try {
        const { stdout } = await execFileP('gh', ['auth', 'token']);
        const token = stdout.trim();
        if (token)
            return token;
    }
    catch {
        // fall through to the error below
    }
    throw new Error('agentcomm: no GitHub token found for the github:// backend. Set AGENTCOMM_GITHUB_TOKEN, ' +
        'GITHUB_TOKEN or GH_TOKEN, or log in with `gh auth login`.');
}
function notFound(key) {
    const err = new Error(`agentcomm: key not found: ${key}`);
    err.code = 'ENOENT';
    return err;
}
async function apiError(res, op) {
    const detail = await res.text().catch(() => '');
    return new Error(`agentcomm: github ${op} failed (HTTP ${res.status}): ${detail.slice(0, 300)}`);
}
function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
}
//# sourceMappingURL=github.js.map