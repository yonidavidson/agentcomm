/**
 * The "already on the network" default: inside a git work tree whose
 * `origin` points at github.com — with a resolvable token — the repo itself
 * is the natural bus, so `github://owner/repo` beats the file:// fallback.
 * Only consulted when nothing explicit chose a backend (flag, env, config
 * file); returns null whenever any prerequisite is missing, which restores
 * the classic `file://./.agentcomm` default.
 */
export declare function detectRepoBus(cwd?: string): Promise<string | null>;
//# sourceMappingURL=autodetect.d.ts.map