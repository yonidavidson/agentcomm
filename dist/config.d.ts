/**
 * Resolve runtime config from CLI flags and environment.
 *
 *   backend:  --backend <uri>   | AGENTCOMM_BACKEND   | default file://./.agentcomm
 *   agent:    --as <name>       | AGENTCOMM_AGENT
 */
export interface ResolvedConfig {
    backendUri: string;
    agent?: string;
    json: boolean;
}
export declare function resolveConfig(flags: ParsedFlags, env: NodeJS.ProcessEnv): ResolvedConfig;
export interface ParsedFlags {
    backend?: string;
    as?: string;
    json: boolean;
    queue?: string;
    subject?: string;
    thread?: string;
    timeout?: number;
    olderThan?: string;
    dryRun: boolean;
    _: string[];
}
/**
 * Minimal, dependency-free flag parser. Supports `--flag value` and
 * `--flag=value`; boolean `--json`. Unknown `--flags` error. Everything else
 * is a positional in `_`.
 */
export declare function parseArgs(argv: string[]): ParsedFlags;
//# sourceMappingURL=config.d.ts.map