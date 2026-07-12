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
export declare function detectRepoBus(cwd?: string): Promise<string | null>;
//# sourceMappingURL=autodetect.d.ts.map