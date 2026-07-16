import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { loadDriver } from './backends/lazy.js';
import type { TelemetryConfig, TelemetryTrackRule } from './telemetry.js';

/**
 * Team conventions — the social contract on top of channels, so "work on x"
 * maps to the same channel URI for every agent without out-of-band knowledge.
 * Defaults live here in code; a project overrides them with an
 * `.agentcomm.json` (zero-dep) or `.agentcomm.yaml`/`.yml` (lazy optional
 * `yaml` package) file found upward from the working directory, or at
 * `AGENTCOMM_CONFIG`. Served by `agentcomm conventions`.
 */
export interface Conventions {
  /** Well-known meeting-room channel: register, announce, ask "who's on what". */
  lobby: string;
  /** How topic channels are named ("work on x" → channel `x` in this style). */
  topicStyle: string;
  /** Channel-name templates bound to repo artifacts (git backends). */
  artifactChannels: {
    issue: string;
    pr: string;
  };
  /** The shared subject vocabulary for message triage. */
  subjects: string[];
}

export const DEFAULT_CONVENTIONS: Conventions = {
  lobby: 'lobby',
  topicStyle: 'kebab-case',
  artifactChannels: { issue: 'issue-<n>', pr: 'pr-<n>' },
  subjects: ['task', 'ack', 'done', 'revision', 'question', 'status'],
};

const CONFIG_FILENAMES = ['.agentcomm.json', '.agentcomm.yaml', '.agentcomm.yml'];

export interface LoadedConfig {
  conventions: Conventions;
  /** Optional default backend URI a project can pin in its config file. */
  backend?: string;
  /**
   * Telemetry capture config (issue #100). PRESENCE is the opt-in — when the
   * config file has no `telemetry` section this stays undefined and every
   * telemetry code path (emit, hook capture) is inert.
   */
  telemetry?: TelemetryConfig;
  /** Absolute path of the override file, or null when running on defaults. */
  source: string | null;
}

/**
 * Load conventions: built-in defaults, overridden (shallow per section) by
 * the nearest config file. `AGENTCOMM_CONFIG` names a file explicitly (an
 * error if unreadable); otherwise the filenames above are searched from
 * `cwd` upward.
 */
export async function loadConventions(
  cwd = process.cwd(),
  env: NodeJS.ProcessEnv = process.env,
): Promise<LoadedConfig> {
  const explicit = env.AGENTCOMM_CONFIG;
  const file = explicit ? path.resolve(cwd, explicit) : await findUp(cwd);
  if (!file) return { conventions: DEFAULT_CONVENTIONS, source: null };

  let raw: string;
  try {
    raw = await fs.readFile(file, 'utf8');
  } catch (err) {
    if (!explicit) return { conventions: DEFAULT_CONVENTIONS, source: null };
    throw new Error(`agentcomm: cannot read AGENTCOMM_CONFIG file ${file}: ${(err as Error).message}`);
  }

  const parsed = await parseConfig(file, raw);
  const c = (parsed.conventions ?? {}) as Partial<Conventions>;
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
    telemetry: parseTelemetry(parsed.telemetry),
    source: file,
  };
}

/** Deterministic-by-construction: only well-formed rules survive parsing. */
function parseTelemetry(raw: unknown): TelemetryConfig | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const t = raw as { track?: unknown; retention?: unknown };
  const track: TelemetryTrackRule[] = [];
  if (Array.isArray(t.track)) {
    for (const r of t.track) {
      if (typeof r !== 'object' || r === null) continue;
      const rule = r as { on?: unknown; match?: unknown; record?: unknown };
      if (typeof rule.on !== 'string' || !rule.on) continue;
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

interface RawConfig {
  conventions?: unknown;
  backend?: unknown;
  telemetry?: unknown;
}

async function parseConfig(file: string, raw: string): Promise<RawConfig> {
  if (file.endsWith('.json')) {
    try {
      return JSON.parse(raw) as RawConfig;
    } catch (err) {
      throw new Error(`agentcomm: invalid JSON in ${file}: ${(err as Error).message}`);
    }
  }
  // .yaml/.yml — the parser is a lazy OPTIONAL dependency, same pattern as
  // the storage drivers: a clear install hint, never a hard requirement.
  const yaml = await loadDriver<{ parse: (s: string) => unknown }>('yaml', 'yaml', 'YAML config files');
  try {
    return (yaml.parse(raw) ?? {}) as RawConfig;
  } catch (err) {
    throw new Error(`agentcomm: invalid YAML in ${file}: ${(err as Error).message}`);
  }
}

async function findUp(startDir: string): Promise<string | null> {
  let dir = path.resolve(startDir);
  for (;;) {
    for (const name of CONFIG_FILENAMES) {
      const candidate = path.join(dir, name);
      try {
        await fs.access(candidate);
        return candidate;
      } catch {
        /* keep looking */
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}
