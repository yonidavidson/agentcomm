import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
/**
 * GitBackend — the generic "commits are the storage" transport, host-agnostic
 * by construction: it drives the `git` binary (plumbing only, no worktree)
 * against ANY remote git understands — GitHub, GitLab, Gitea, Bitbucket, a
 * private server, or a plain directory. Auth is whatever git already has
 * (SSH keys, credential helpers, netrc) — agentcomm adds none. No API, no
 * rate limits.
 *
 * URIs (npm-style `git+` schemes; params: ?branch=<bus branch, default
 * 'agentcomm'>, ?channel=<isolated channel>):
 *
 *   git+ssh://git@gitlab.com/acme/webapp.git?channel=team-a
 *   git+https://github.com/acme/webapp.git
 *   git+file:///srv/buses/webapp.git          # local/NFS bare repo
 *
 * How it works: a bare cache repo per remote lives under
 * `~/.cache/agentcomm/git/<sha1(remote)>.git` (override with
 * AGENTCOMM_GIT_CACHE_DIR). Every read starts with a fetch of the bus branch
 * (strong consistency: after fetch, the objects are local). Every write
 * builds blob → tree (temp index) → commit with plumbing and pushes; a
 * rejected non-fast-forward push means someone else committed first — fetch
 * and retry.
 *
 * Because `git push` is a compare-and-swap, this backend supports what the
 * REST-API github:// backend cannot:
 *   - `move` is ATOMIC (copy + delete in one commit), and
 *   - `claim` is implemented (Claimable) via optimistic CAS — race-free
 *     shared work queues with zero infrastructure.
 */
export class GitBackend {
    remote;
    branch;
    keyPrefix;
    dir;
    /** Each poll is a real fetch — cheap against local remotes, a round trip against hosts. */
    pollIntervalMs = 2000;
    constructor(remote, branch, 
    /** '' for the root channel, or 'channels/<name>/' for a carved channel. */
    keyPrefix, 
    /** Path of the bare cache repo (the --git-dir for every command). */
    dir) {
        this.remote = remote;
        this.branch = branch;
        this.keyPrefix = keyPrefix;
        this.dir = dir;
    }
    static async open(remote, branch = 'agentcomm', channel = '') {
        const cacheRoot = process.env.AGENTCOMM_GIT_CACHE_DIR ??
            path.join(process.env.XDG_CACHE_HOME ?? path.join(os.homedir(), '.cache'), 'agentcomm', 'git');
        const dir = path.join(cacheRoot, `${createHash('sha1').update(remote).digest('hex').slice(0, 16)}.git`);
        const backend = new GitBackend(remote, branch, channel ? `channels/${channel}/` : '', dir);
        try {
            await fs.access(path.join(dir, 'HEAD'));
        }
        catch {
            await fs.mkdir(dir, { recursive: true });
            await backend.git(['init', '--bare', '--quiet', dir], { cwd: cacheRoot, noGitDir: true });
            await backend.git(['remote', 'add', 'origin', remote]);
        }
        return backend;
    }
    k(key) {
        return this.keyPrefix + key;
    }
    /** Run git against the cache repo; binary-safe stdout; never prompts. */
    git(args, opts = {}) {
        const full = opts.noGitDir ? args : ['--git-dir', this.dir, ...args];
        return new Promise((resolve, reject) => {
            const child = spawn('git', full, {
                cwd: opts.cwd ?? this.dir,
                env: {
                    ...process.env,
                    GIT_TERMINAL_PROMPT: '0', // fail fast instead of hanging on an auth prompt
                    // No detached background gc/maintenance on the cache repo — it
                    // races our next op (and test cleanup) on objects/pack. The cache
                    // is disposable; nobody needs it optimized.
                    GIT_CONFIG_COUNT: '2',
                    GIT_CONFIG_KEY_0: 'gc.auto',
                    GIT_CONFIG_VALUE_0: '0',
                    GIT_CONFIG_KEY_1: 'maintenance.auto',
                    GIT_CONFIG_VALUE_1: 'false',
                    GIT_AUTHOR_NAME: 'agentcomm',
                    GIT_AUTHOR_EMAIL: 'bus@agentcomm.local',
                    GIT_COMMITTER_NAME: 'agentcomm',
                    GIT_COMMITTER_EMAIL: 'bus@agentcomm.local',
                    ...(opts.env ?? {}),
                },
                stdio: ['pipe', 'pipe', 'pipe'],
            });
            const out = [];
            const err = [];
            child.stdout.on('data', (d) => out.push(d));
            child.stderr.on('data', (d) => err.push(d));
            child.on('error', (e) => reject(e.message.includes('ENOENT') ? new Error('agentcomm: the git+ backends need the `git` binary on PATH') : e));
            child.on('close', (code) => {
                if (code === 0)
                    resolve(Buffer.concat(out));
                else {
                    const e = new Error(`agentcomm: git ${args[0]} failed (exit ${code}): ${Buffer.concat(err).toString('utf8').trim().slice(0, 400)}`);
                    e.gitStderr = Buffer.concat(err).toString('utf8');
                    reject(e);
                }
            });
            if (opts.input !== undefined)
                child.stdin.write(opts.input);
            child.stdin.end();
        });
    }
    /** Fetch the bus branch; its local tip sha, or null when it doesn't exist yet. */
    async tip() {
        try {
            await this.git(['fetch', '--quiet', 'origin', `+refs/heads/${this.branch}:refs/agentcomm/tip`]);
        }
        catch (err) {
            const stderr = err.gitStderr ?? '';
            if (/couldn'?t find remote ref|Could not find remote ref/i.test(stderr))
                return null;
            throw err;
        }
        return (await this.git(['rev-parse', 'refs/agentcomm/tip'])).toString('utf8').trim();
    }
    /**
     * Build a commit on `tip` applying `changes` and push it as the new branch
     * head. Returns true when the push landed, false on a lost CAS race
     * (non-fast-forward — someone else committed first; caller refetches and
     * retries). Any other push failure throws.
     */
    async commitAndPush(tip, message, changes) {
        const index = path.join(os.tmpdir(), `agentcomm-idx-${process.pid}-${Math.random().toString(36).slice(2)}`);
        // GIT_WORK_TREE satisfies update-index's bare-repo refusal; with
        // --cacheinfo no command ever touches the (phantom) work tree.
        const env = { GIT_INDEX_FILE: index, GIT_WORK_TREE: this.dir };
        try {
            if (tip)
                await this.git(['read-tree', tip], { env });
            else
                await this.git(['read-tree', '--empty'], { env });
            for (const { key, blob } of changes.add ?? []) {
                await this.git(['update-index', '--add', '--cacheinfo', `100644,${blob},${this.k(key)}`], { env });
            }
            for (const key of changes.remove ?? []) {
                await this.git(['update-index', '--force-remove', this.k(key)], { env });
            }
            const tree = (await this.git(['write-tree'], { env })).toString('utf8').trim();
            const commit = (await this.git(['commit-tree', tree, ...(tip ? ['-p', tip] : []), '-m', message]))
                .toString('utf8')
                .trim();
            try {
                await this.git(['push', '--quiet', 'origin', `${commit}:refs/heads/${this.branch}`]);
                return true;
            }
            catch (err) {
                const stderr = err.gitStderr ?? '';
                if (/non-fast-forward|fetch first|failed to push|stale info/i.test(stderr))
                    return false;
                throw err;
            }
        }
        finally {
            await fs.rm(index, { force: true }).catch(() => { });
        }
    }
    async writeBlob(data) {
        return (await this.git(['hash-object', '-w', '--stdin'], { input: data })).toString('utf8').trim();
    }
    async put(key, data) {
        const blob = await this.writeBlob(data);
        for (let attempt = 1; attempt <= 6; attempt++) {
            const tip = await this.tip();
            if (await this.commitAndPush(tip, `agentcomm: put ${this.k(key)}`, { add: [{ key, blob }] }))
                return;
            await sleep(30 * attempt + Math.floor(Math.random() * 80));
        }
        throw new Error(`agentcomm: git put ${key} kept losing push races — extremely contended bus?`);
    }
    async get(key) {
        const tip = await this.tip();
        if (tip === null)
            throw notFound(key);
        try {
            return await this.git(['cat-file', 'blob', `${tip}:${this.k(key)}`]);
        }
        catch {
            throw notFound(key);
        }
    }
    async list(prefix) {
        const tip = await this.tip();
        if (tip === null)
            return [];
        const all = (await this.git(['ls-tree', '-r', '--name-only', '-z', tip])).toString('utf8');
        const full = this.k(prefix);
        return all
            .split('\0')
            .filter((p) => p.length > 0 && p.startsWith(full) && p.startsWith(this.keyPrefix))
            .map((p) => p.slice(this.keyPrefix.length))
            .sort();
    }
    async delete(key) {
        for (let attempt = 1; attempt <= 6; attempt++) {
            const tip = await this.tip();
            if (tip === null)
                return;
            if (!(await this.exists(key, tip)))
                return; // absent → no-op, per the contract
            if (await this.commitAndPush(tip, `agentcomm: delete ${this.k(key)}`, { remove: [key] }))
                return;
            await sleep(30 * attempt + Math.floor(Math.random() * 80));
        }
        throw new Error(`agentcomm: git delete ${key} kept losing push races`);
    }
    async exists(key, atTip) {
        const tip = atTip ?? (await this.tip());
        if (tip === null)
            return false;
        try {
            await this.git(['cat-file', '-e', `${tip}:${this.k(key)}`]);
            return true;
        }
        catch {
            return false;
        }
    }
    async move(src, dst) {
        // One commit adds dst and removes src — push lands it atomically.
        for (let attempt = 1; attempt <= 6; attempt++) {
            const tip = await this.tip();
            if (tip === null)
                throw notFound(src);
            let blob;
            try {
                blob = (await this.git(['rev-parse', `${tip}:${this.k(src)}`])).toString('utf8').trim();
            }
            catch {
                throw notFound(src);
            }
            // Nonce for the same reason as claim: identical concurrent moves must
            // not collide into one sha and report false success to both movers.
            if (await this.commitAndPush(tip, `agentcomm: move ${this.k(src)} → ${this.k(dst)} [${randomUUID().slice(0, 8)}]`, {
                add: [{ key: dst, blob }],
                remove: [src],
            })) {
                return;
            }
            await sleep(30 * attempt + Math.floor(Math.random() * 80));
        }
        throw new Error(`agentcomm: git move ${src} kept losing push races`);
    }
    /**
     * Atomic shared-queue dequeue via push CAS: pick the oldest inbox message,
     * push a commit that archives it; if the push is rejected, someone else
     * moved first — refetch and try the (new) oldest. Race-free with zero
     * coordination infrastructure.
     */
    async claim(queue, _owner) {
        for (let attempt = 1; attempt <= 12; attempt++) {
            const tip = await this.tip();
            if (tip === null)
                return null;
            const inboxPrefix = this.k(`inbox/${queue}/`);
            const pending = (await this.git(['ls-tree', '-r', '--name-only', '-z', tip]))
                .toString('utf8')
                .split('\0')
                .filter((p) => p.startsWith(inboxPrefix) && p.endsWith('.json'))
                .sort();
            if (pending.length === 0)
                return null;
            const oldest = pending[0].slice(this.keyPrefix.length);
            const blob = (await this.git(['rev-parse', `${tip}:${this.k(oldest)}`])).toString('utf8').trim();
            const dst = 'read/' + oldest.slice('inbox/'.length);
            // The commit message MUST be unique per claimer: git timestamps have
            // second resolution, so two racers building the same tree on the same
            // parent in the same second would mint the SAME commit sha — and the
            // loser's push would report "up to date" (exit 0), double-delivering
            // the message. The owner+nonce breaks sha equality (and records who
            // claimed, for free).
            if (await this.commitAndPush(tip, `agentcomm: claim ${this.k(oldest)} by ${_owner} [${randomUUID().slice(0, 8)}]`, {
                add: [{ key: dst, blob }],
                remove: [oldest],
            })) {
                return JSON.parse((await this.git(['cat-file', 'blob', blob])).toString('utf8'));
            }
            await sleep(20 * attempt + Math.floor(Math.random() * 60));
        }
        throw new Error(`agentcomm: git claim on ${queue} kept losing push races — try again`);
    }
}
function notFound(key) {
    const err = new Error(`agentcomm: key not found: ${key}`);
    err.code = 'ENOENT';
    return err;
}
function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
}
//# sourceMappingURL=git.js.map