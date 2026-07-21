import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { loadDriver } from './backends/lazy.js';
export const DEFAULT_CONVENTIONS = {
    lobby: 'lobby',
    topicStyle: 'kebab-case',
    artifactChannels: { issue: 'issue-<n>', pr: 'pr-<n>' },
    subjects: ['task', 'ack', 'done', 'revision', 'question', 'status'],
};
const CONFIG_FILENAMES = ['.agentcomm.json', '.agentcomm.yaml', '.agentcomm.yml'];
/** `~`/`~/x` → the user's home directory (repo pointers are often cross-project paths). */
export function expandTilde(p) {
    if (p === '~')
        return os.homedir();
    if (p.startsWith('~/'))
        return path.join(os.homedir(), p.slice(2));
    return p;
}
/**
 * Load conventions: built-in defaults, overridden (shallow per section) by
 * the nearest config file. `AGENTCOMM_CONFIG` names a file explicitly (an
 * error if unreadable); otherwise the filenames above are searched from
 * `cwd` upward.
 */
export async function loadConventions(cwd = process.cwd(), env = process.env) {
    const explicit = env.AGENTCOMM_CONFIG;
    const file = explicit ? path.resolve(cwd, explicit) : await findUp(cwd);
    if (!file)
        return { conventions: DEFAULT_CONVENTIONS, source: null };
    let raw;
    try {
        raw = await fs.readFile(file, 'utf8');
    }
    catch (err) {
        if (!explicit)
            return { conventions: DEFAULT_CONVENTIONS, source: null };
        throw new Error(`agentcomm: cannot read AGENTCOMM_CONFIG file ${file}: ${err.message}`);
    }
    const parsed = await parseConfig(file, raw);
    const c = (parsed.conventions ?? {});
    return {
        conventions: {
            lobby: typeof c.lobby === 'string' ? c.lobby : DEFAULT_CONVENTIONS.lobby,
            topicStyle: typeof c.topicStyle === 'string' ? c.topicStyle : DEFAULT_CONVENTIONS.topicStyle,
            artifactChannels: {
                ...DEFAULT_CONVENTIONS.artifactChannels,
                ...(typeof c.artifactChannels === 'object' && c.artifactChannels !== null ? c.artifactChannels : {}),
            },
            subjects: Array.isArray(c.subjects) && c.subjects.every((s) => typeof s === 'string')
                ? c.subjects
                : DEFAULT_CONVENTIONS.subjects,
        },
        backend: typeof parsed.backend === 'string' ? parsed.backend : undefined,
        // Relative pointers are relative to the config file that declares them,
        // not to wherever the CLI happens to run.
        repo: typeof parsed.repo === 'string' && parsed.repo
            ? path.resolve(path.dirname(file), expandTilde(parsed.repo))
            : undefined,
        telemetry: parseTelemetry(parsed.telemetry),
        source: file,
    };
}
/** Deterministic-by-construction: only well-formed rules survive parsing. */
function parseTelemetry(raw) {
    if (typeof raw !== 'object' || raw === null)
        return undefined;
    const t = raw;
    const track = [];
    if (Array.isArray(t.track)) {
        for (const r of t.track) {
            if (typeof r !== 'object' || r === null)
                continue;
            const rule = r;
            if (typeof rule.on !== 'string' || !rule.on)
                continue;
            track.push({
                on: rule.on,
                ...(typeof rule.match === 'string' ? { match: rule.match } : {}),
                ...(typeof rule.record === 'string' ? { record: rule.record } : {}),
            });
        }
    }
    return {
        track,
        ...(typeof t.retention === 'string' ? { retention: t.retention } : {}),
    };
}
async function parseConfig(file, raw) {
    if (file.endsWith('.json')) {
        try {
            return JSON.parse(raw);
        }
        catch (err) {
            throw new Error(`agentcomm: invalid JSON in ${file}: ${err.message}`);
        }
    }
    // .yaml/.yml — the parser is a lazy OPTIONAL dependency, same pattern as
    // the storage drivers: a clear install hint, never a hard requirement.
    const yaml = await loadDriver('yaml', 'yaml', 'YAML config files');
    try {
        return (yaml.parse(raw) ?? {});
    }
    catch (err) {
        throw new Error(`agentcomm: invalid YAML in ${file}: ${err.message}`);
    }
}
async function findUp(startDir) {
    let dir = path.resolve(startDir);
    for (;;) {
        for (const name of CONFIG_FILENAMES) {
            const candidate = path.join(dir, name);
            try {
                await fs.access(candidate);
                return candidate;
            }
            catch {
                /* keep looking */
            }
        }
        const parent = path.dirname(dir);
        if (parent === dir)
            return null;
        dir = parent;
    }
}
//# sourceMappingURL=conventions.js.map