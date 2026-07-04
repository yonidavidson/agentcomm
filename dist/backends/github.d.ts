import { type Backend } from '../types.js';
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
export declare class GithubBackend implements Backend {
    private readonly owner;
    private readonly repo;
    private readonly branch;
    private readonly basePrefix;
    private readonly token;
    /**
     * Bus.wait polls `list()` — at its 250ms default this backend would burn
     * ~8 API calls/second of a 5,000/hr shared quota. Declared hint; Bus
     * honors it unless the caller passes an explicit interval.
     */
    readonly pollIntervalMs = 3000;
    /**
     * The newest commit WE created (from put/delete responses). Ref lookups
     * can lag even a fresh commit; when they disagree with this, one compare
     * call decides which is newer — read-your-write must hold.
     */
    private lastWriteTip;
    private constructor();
    static open(owner: string, repo: string, basePrefix?: string, branch?: string): Promise<GithubBackend>;
    private k;
    private static cacheBust;
    private bust;
    private contentsUrl;
    private api;
    /**
     * Current tip commit of the bus branch (null when the branch doesn't exist
     * yet). Reads pin themselves to this immutable sha: reading contents by
     * branch NAME can lag a just-made commit (server-side replication), while
     * the cache-busted ref lookup is fresh — so ref-then-sha is how every read
     * stays read-your-write consistent.
     */
    private tip;
    /** Current blob sha of a key on the bus branch, or null when absent. */
    private shaOf;
    put(key: string, data: Buffer): Promise<void>;
    /**
     * First write: create the bus branch as an ORPHAN ref (parentless commit)
     * carrying this one file. Returns false if another agent created the
     * branch first (caller retries via the contents API).
     */
    private createOrphanBranch;
    get(key: string): Promise<Buffer>;
    list(prefix: string): Promise<string[]>;
    delete(key: string): Promise<void>;
    exists(key: string): Promise<boolean>;
    move(src: string, dst: string): Promise<void>;
}
/**
 * Token discovery for the github backend, in priority order:
 * AGENTCOMM_GITHUB_TOKEN → GITHUB_TOKEN → GH_TOKEN → `gh auth token`.
 * Exported for reuse (tests, tooling).
 */
export declare function resolveGithubToken(): Promise<string>;
//# sourceMappingURL=github.d.ts.map