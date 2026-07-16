/**
 * Harness lifecycle core — the bus behaviors (register + brief, inbox guard,
 * mid-turn digest) as in-process functions, for harness plugins that import
 * the library rather than shelling out to the CLI (OpenCode, Pi — both run on
 * Bun, where spawning the Node hook scripts is fragile).
 *
 * Everything fails open: a broken bus must never wedge a session.
 */
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { Bus, type AgentRecord } from './bus.js';
import { createBackend } from './backends/index.js';
import { detectRepoBus } from './backends/autodetect.js';
import { loadConventions } from './conventions.js';
import { deriveIdentity, sessionHash } from './identity.js';
import { flushEvents, materializeEvent, spoolEvents, type TelemetryTrackRule } from './telemetry.js';

const MARKER = '<!-- agentcomm -->';

/** Consent gate: act only where the repo opted in (AGENTCOMM_BACKEND, or a marked CLAUDE.md/AGENTS.md). */
export async function onTheBus(cwd: string): Promise<boolean> {
  if (process.env.AGENTCOMM_BACKEND) return true;
  let dir = cwd;
  for (;;) {
    for (const f of ['CLAUDE.md', 'AGENTS.md']) {
      try {
        if ((await fs.readFile(path.join(dir, f), 'utf8')).includes(MARKER)) return true;
      } catch {
        /* keep walking */
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) return false;
    dir = parent;
  }
}

/** Resolve this repo's bus URI the same way the CLI does (env > config > git remote > file://). */
async function resolveBusUri(cwd: string): Promise<string> {
  if (process.env.AGENTCOMM_BACKEND) return process.env.AGENTCOMM_BACKEND;
  const fromConfig = (await loadConventions(cwd).catch(() => null))?.backend;
  if (fromConfig) return fromConfig;
  const detected = await detectRepoBus(cwd).catch(() => null);
  if (detected) return detected;
  return `file://${path.join(cwd, '.agentcomm')}`;
}

export interface BusSession {
  bus: Bus;
  backend: Awaited<ReturnType<typeof createBackend>>;
  alias: string;
  busUri: string;
  /** The repo the session runs in — where the .agentcomm (telemetry) config lives. */
  cwd: string;
  close(): Promise<void>;
}

/** Open the bus for `cwd` and resolve this session's alias. Returns null if off-bus or on any error. */
export async function openBusSession(cwd: string): Promise<BusSession | null> {
  try {
    if (!(await onTheBus(cwd))) return null;
    const busUri = await resolveBusUri(cwd);
    const backend = await createBackend(busUri);
    const alias = process.env.AGENTCOMM_AGENT ?? (await deriveIdentity()).name;
    if (!alias) {
      await backend.close?.();
      return null;
    }
    return {
      bus: new Bus(backend),
      backend,
      alias,
      busUri,
      cwd,
      close: async () => {
        await backend.close?.();
      },
    };
  } catch {
    return null;
  }
}

const active = (a: AgentRecord) => Date.now() - Date.parse(a.lastSeen) < 10 * 60_000;
const isAsk = (s?: string) => /^(blocked|need|help)\b/i.test(s ?? '');

/** The repo's telemetry track rules — [] means not opted in (issue #100). */
async function telemetryTrack(s: BusSession): Promise<TelemetryTrackRule[]> {
  try {
    return (await loadConventions(s.cwd))?.telemetry?.track ?? [];
  } catch {
    return [];
  }
}

/** Ship any locally-spooled telemetry with a write that just happened — fail-open. */
async function rideAlong(s: BusSession): Promise<void> {
  try {
    await flushEvents(s.backend, s.busUri, s.alias);
  } catch {
    /* events stay spooled for the next ride */
  }
}

/** Register (heartbeat) + build the session-start briefing the model should see. */
export async function sessionStartContext(s: BusSession): Promise<string | null> {
  try {
    const session = await sessionHash();
    const track = await telemetryTrack(s);
    // deterministic capture: if the repo tracks sessions, this fires — the
    // spool then rides the register we are about to make anyway
    if (track.some((r) => r.on === 'session')) {
      await spoolEvents(s.busUri, s.alias, [
        materializeEvent({ agent: s.alias, session, type: 'session-start' }),
      ]);
    }
    await s.bus.register(s.alias, session);
    await rideAlong(s);
    const roster = await s.bus.agents();
    const pending = await s.bus.peek(s.alias);
    const others = roster.filter((a) => a.name !== s.alias && active(a));
    const lines = [
      `agentcomm: this repo is on a message bus (${s.busUri}). You are registered as ${s.alias}.`,
      pending.length
        ? `${pending.length} message(s) already waiting for you — run \`agentcomm inbox --json\`.`
        : null,
      roster.length
        ? `Roster: ${roster.length} agent(s), ${others.length + 1} active — ${roster
            .map((a) => a.name + (a.name === s.alias ? ' (you)' : '') + (a.status ? ` [${a.status}]` : ''))
            .join(', ')}.`
        : null,
      ...others
        .filter((a) => isAsk(a.status))
        .map(
          (a) =>
            `call to action — ${a.name} is asking: "${a.status}". If you can answer from what you already know, \`agentcomm send ${a.name} "<answer>" --subject status\`.`,
        ),
      'See who is on the bus and what they are doing any time with `agentcomm network`.',
      // telemetry semantic layer: outcomes only the model can judge are
      // self-reported — surface the repo's record: instructions
      ...(() => {
        const recs = track.filter((r) => r.record);
        if (!recs.length) return [] as string[];
        return [
          'Telemetry (repo opt-in via .agentcomm config): hooks record tracked events automatically; YOU self-report the outcomes below when they happen, with `agentcomm emit`:',
          ...recs
            .slice(0, 6)
            .map(
              (r) =>
                `  - after ${r.on}${r.match ? ` "${r.match}"` : ''}: record ${r.record} — \`agentcomm emit --type ${r.on}-outcome${r.match ? ` --name ${r.match}` : ''} --ref "$(git branch --show-current)" --attrs '{"…":"…"}'\``,
            ),
        ];
      })(),
    ].filter(Boolean);
    return lines.join('\n');
  } catch {
    return null;
  }
}

/** Inbox guard: non-consuming peek → a reason string when unread mail exists, else null. */
export async function inboxGuardReason(s: BusSession): Promise<string | null> {
  try {
    const pending = await s.bus.peek(s.alias);
    if (!pending.length) return null;
    const from = [...new Set(pending.map((m) => m.from))].join(', ');
    return (
      `agentcomm: ${pending.length} unread bus message(s) for ${s.alias} (from: ${from}). ` +
      'Read them with `agentcomm inbox --json` and act before finishing.'
    );
  } catch {
    return null;
  }
}

/** Mid-turn digest: register (heartbeat) + surface only actionable signals (unread mail, active asks). */
export async function midTurnContext(s: BusSession): Promise<string | null> {
  try {
    await s.bus.register(s.alias, await sessionHash());
    await rideAlong(s); // the heartbeat is a ride for any spooled telemetry
    const pending = await s.bus.peek(s.alias);
    const roster = await s.bus.agents();
    const asks = roster.filter((a) => a.name !== s.alias && active(a) && isAsk(a.status));
    if (!pending.length && !asks.length) return null;
    const lines: string[] = [];
    if (pending.length)
      lines.push(
        `agentcomm (mid-task): ${pending.length} unread message(s) for ${s.alias} — \`agentcomm inbox --json\` if it may affect the current work, otherwise finish first.`,
      );
    for (const a of asks.slice(0, 2))
      lines.push(
        `agentcomm (mid-task): ${a.name} is asking "${a.status}" — reply only if you already know the answer; do not derail the current task.`,
      );
    return lines.join('\n');
  } catch {
    return null;
  }
}
