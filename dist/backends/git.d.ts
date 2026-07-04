import { type Backend, type Claimable, type Message } from '../types.js';
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
export declare class GitBackend implements Backend, Claimable {
    private readonly remote;
    private readonly branch;
    /** '' for the root channel, or 'channels/<name>/' for a carved channel. */
    private readonly keyPrefix;
    /** Path of the bare cache repo (the --git-dir for every command). */
    private readonly dir;
    /** Each poll is a real fetch — cheap against local remotes, a round trip against hosts. */
    readonly pollIntervalMs = 2000;
    private constructor();
    static open(remote: string, branch?: string, channel?: string): Promise<GitBackend>;
    private k;
    /** Run git against the cache repo; binary-safe stdout; never prompts. */
    private git;
    /** Fetch the bus branch; its local tip sha, or null when it doesn't exist yet. */
    private tip;
    /**
     * Build a commit on `tip` applying `changes` and push it as the new branch
     * head. Returns true when the push landed, false on a lost CAS race
     * (non-fast-forward — someone else committed first; caller refetches and
     * retries). Any other push failure throws.
     */
    private commitAndPush;
    private writeBlob;
    put(key: string, data: Buffer): Promise<void>;
    get(key: string): Promise<Buffer>;
    list(prefix: string): Promise<string[]>;
    delete(key: string): Promise<void>;
    exists(key: string, atTip?: string): Promise<boolean>;
    move(src: string, dst: string): Promise<void>;
    /**
     * Atomic shared-queue dequeue via push CAS: pick the oldest inbox message,
     * push a commit that archives it; if the push is rejected, someone else
     * moved first — refetch and try the (new) oldest. Race-free with zero
     * coordination infrastructure.
     */
    claim(queue: string, _owner: string): Promise<Message | null>;
}
//# sourceMappingURL=git.d.ts.map