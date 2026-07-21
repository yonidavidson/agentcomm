/**
 * Resolve runtime config from CLI flags and environment.
 *
 *   backend:  --backend <uri>   | AGENTCOMM_BACKEND   | default file://./.agentcomm
 *   agent:    --as <name>       | AGENTCOMM_AGENT
 */
const DEFAULT_BACKEND = 'file://./.agentcomm';
export function resolveConfig(flags, env) {
    const backendUri = flags.backend ?? env.AGENTCOMM_BACKEND ?? DEFAULT_BACKEND;
    const agent = flags.as ?? env.AGENTCOMM_AGENT;
    return { backendUri, agent, json: flags.json };
}
/**
 * Minimal, dependency-free flag parser. Supports `--flag value` and
 * `--flag=value`; boolean `--json`. Unknown `--flags` error. Everything else
 * is a positional in `_`.
 */
export function parseArgs(argv) {
    const flags = { json: false, dryRun: false, flush: false, version: false, _: [] };
    for (let i = 0; i < argv.length; i++) {
        const tok = argv[i];
        if (!tok.startsWith('--')) {
            flags._.push(tok);
            continue;
        }
        const eq = tok.indexOf('=');
        const name = eq === -1 ? tok.slice(2) : tok.slice(2, eq);
        const inlineVal = eq === -1 ? undefined : tok.slice(eq + 1);
        const takeVal = () => {
            if (inlineVal !== undefined)
                return inlineVal;
            const next = argv[++i];
            if (next === undefined)
                throw new Error(`agentcomm: flag --${name} expects a value`);
            return next;
        };
        switch (name) {
            case 'backend':
                flags.backend = takeVal();
                break;
            case 'as':
                flags.as = takeVal();
                break;
            case 'json':
                flags.json = true;
                break;
            case 'queue':
                flags.queue = takeVal();
                break;
            case 'subject':
                flags.subject = takeVal();
                break;
            case 'thread':
                flags.thread = takeVal();
                break;
            case 'timeout':
                flags.timeout = Number(takeVal());
                break;
            case 'older-than':
                flags.olderThan = takeVal();
                break;
            case 'agents-older-than':
                flags.agentsOlderThan = takeVal();
                break;
            case 'dry-run':
                flags.dryRun = true;
                break;
            case 'repo':
                flags.repo = takeVal();
                break;
            case 'version':
                flags.version = true;
                break;
            case 'daemon':
                flags.daemon = true;
                break;
            case 'direct':
                flags.direct = true;
                break;
            case 'sync':
                flags.sync = true;
                break;
            case 'status':
                flags.status = takeVal();
                break;
            case 'status-auto':
                flags.status = takeVal();
                flags.statusAuto = true;
                break;
            case 'limit':
                flags.limit = Number(takeVal());
                break;
            case 'harness':
                flags.harness = takeVal();
                break;
            case 'type':
                flags.type = takeVal();
                break;
            case 'name':
                flags.name = takeVal();
                break;
            case 'ref':
                flags.ref = takeVal();
                break;
            case 'attrs':
                flags.attrs = takeVal();
                break;
            case 'flush':
                flags.flush = true;
                break;
            case 'events':
                flags.events = takeVal();
                break;
            case 'since':
                flags.since = takeVal();
                break;
            case 'help':
                flags._.push('--help');
                break;
            default:
                throw new Error(`agentcomm: unknown flag --${name}`);
        }
    }
    return flags;
}
//# sourceMappingURL=config.js.map