/**
 * `agentcomm hook <event>` — the harness lifecycle hooks, in the CLI.
 *
 * Ports the retired plugin hook scripts (hooks/*.mjs) verbatim: stdin JSON in,
 * hook-protocol JSON on stdout, exit 0 always. `hooks --harness claude|codex`
 * writes the config that points the harness here, so ONE globally-installed
 * CLI is the entire integration — no plugin, no marketplace, no bundled
 * scripts. Hooks must NEVER break a session: every path fails open.
 *
 * Bus calls self-spawn the CLI (rather than going in-process) on purpose:
 * the child inherits this hook process's ancestry and env, so the derived
 * session alias matches the agent's own `agentcomm` commands exactly.
 */
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { onTheBus } from './harness.js';
import { loadConventions } from './conventions.js';
import { updateNotice } from './update-check.js';

interface HookInput {
  cwd?: string;
  hook_event_name?: string;
  stop_hook_active?: boolean;
  task_subject?: string;
  tool_name?: string;
  tool_input?: { skill?: string; name?: string; subagent_type?: string; command?: string };
}

async function readStdinJson(): Promise<HookInput> {
  try {
    const chunks: Buffer[] = [];
    for await (const c of process.stdin) chunks.push(c as Buffer);
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as HookInput;
  } catch {
    return {};
  }
}

/**
 * Align the derived alias with the agent's own Bash commands. Both inherit
 * the terminal-session env, so usually nothing is needed; in the gppid
 * fallback the agent's CLI lands on the harness pid — our ancestor too.
 */
async function sessionEnv(): Promise<Record<string, string>> {
  if (
    process.env.AGENTCOMM_SESSION ||
    process.env.ITERM_SESSION_ID ||
    process.env.TERM_SESSION_ID ||
    process.env.TMUX_PANE
  ) {
    return {};
  }
  try {
    const ps = (pid: number | string, field: string): Promise<string> =>
      new Promise((res, rej) =>
        execFile('ps', ['-o', `${field}=`, '-p', String(pid)], (e, out) => (e ? rej(e) : res(out.trim()))),
      );
    const parent = process.ppid;
    const comm = await ps(parent, 'comm');
    // hooks run as `sh -c agentcomm …` or as a direct child of the harness;
    // the harness process is the first non-shell ancestor
    const harness = /(^|\/)(sh|bash|zsh|dash)$/.test(comm) ? await ps(parent, 'ppid') : String(parent);
    return { AGENTCOMM_SESSION: `gppid:${harness}` };
  } catch {
    return {};
  }
}

interface CliResult {
  json: unknown;
  stderr: string;
}

/**
 * Run the CLI (this very entry script, so dev/tsx and installed layouts both
 * work — execArgv carries any loader flags). JSON out + stderr notices.
 * Null on any failure or timeout.
 */
async function cli(args: string[], cwd: string, timeoutMs = 10_000): Promise<CliResult | null> {
  try {
    const env = { ...process.env, ...(await sessionEnv()) };
    return await new Promise((resolve) => {
      const child = execFile(
        process.execPath,
        [...process.execArgv, process.argv[1]!, ...args],
        { cwd, env, timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 },
        (err, stdout, stderr) => {
          if (err) return resolve(null);
          try {
            resolve({ json: JSON.parse(stdout), stderr });
          } catch {
            resolve(null);
          }
        },
      );
      child.on('error', () => resolve(null));
    });
  } catch {
    return null;
  }
}

function busUriFrom(stderr: string | undefined): string | null {
  const m = /agentcomm: using (\S+)/.exec(stderr ?? '');
  return m?.[1] ?? process.env.AGENTCOMM_BACKEND ?? null;
}

function aliasFrom(stderr: string | undefined): string | null {
  const m = /acting as (\S+)/.exec(stderr ?? '');
  return m?.[1] ?? null;
}

interface LogMsg {
  from: string;
  to: string;
  subject?: string;
  body: string;
  ts: string;
}
interface AgentRow {
  name: string;
  status?: string;
  lastSeen: string;
  thisSession?: boolean;
}

/**
 * What moved on the bus since this hook last looked: recent messages
 * (including between OTHER agents — the bus is a shared, trusted space),
 * excluding our own sends. High-water mark kept in stateFile. First run
 * primes the mark silently — no history dump on fresh sessions.
 */
async function activitySince(
  cwd: string,
  me: string | null,
  stateFile: string,
  cap = 4,
): Promise<{ lines: string[] }> {
  const res = await cli(['log', '--limit', '30', '--json'], cwd, 3_000);
  if (!res || !Array.isArray(res.json)) return { lines: [] };
  const msgs = res.json as LogMsg[];
  let lastTs = 0;
  let first = true;
  try {
    const st = JSON.parse(await fs.readFile(stateFile, 'utf8')) as { lastTs?: number };
    if (typeof st?.lastTs === 'number') {
      lastTs = st.lastTs;
      first = false;
    }
  } catch {
    /* first run */
  }
  const newest = msgs.reduce((m, x) => Math.max(m, Date.parse(x.ts) || 0), lastTs);
  await fs.writeFile(stateFile, JSON.stringify({ lastTs: newest })).catch(() => {});
  if (first) return { lines: [] };
  const fresh = msgs.filter((m) => (Date.parse(m.ts) || 0) > lastTs && m.from !== me);
  return {
    lines: fresh.slice(-cap).map((m) => {
      const body = m.body.length > 70 ? m.body.slice(0, 70) + '…' : m.body;
      return `${m.from} → ${m.to}${m.subject ? ` [${m.subject}]` : ''}: "${body}"`;
    }),
  };
}

const cwdKey = (cwd: string): string => createHash('sha1').update(cwd).digest('hex').slice(0, 12);

/** Which harness is calling? Claude Code sets CLAUDE_PROJECT_DIR/CLAUDECODE for its hooks; Codex does not. */
const isClaude = (): boolean => Boolean(process.env.CLAUDE_PROJECT_DIR || process.env.CLAUDECODE);

// ── session-start ───────────────────────────────────────────────────────────

async function hookSessionStart(input: HookInput): Promise<void> {
  const cwd = input.cwd || process.cwd();
  if (!(await onTheBus(cwd))) return;

  // The guidance-file contract says agents register at session start — the
  // hook does it (heartbeat onto the roster), throttled so restarts don't
  // spam bus commits, then reports waiting mail and the roster.
  const stamp = path.join(os.tmpdir(), `agentcomm-register-${cwdKey(cwd)}`);
  let fresh = false;
  try {
    fresh = Date.now() - (await fs.stat(stamp)).mtimeMs < 10 * 60_000;
  } catch {
    /* never registered from here */
  }

  const reg = fresh ? null : await cli(['register', '--json'], cwd, 20_000);
  if (reg) await fs.writeFile(stamp, '').catch(() => {});
  const peek = await cli(['peek', '--json'], cwd);
  if (!peek) return;
  const res = await cli(['agents', '--json'], cwd);

  const bus = busUriFrom(peek.stderr) ?? busUriFrom(reg?.stderr);
  const alias = aliasFrom(peek.stderr) ?? (reg?.json as { name?: string } | undefined)?.name;
  const pending = Array.isArray(peek.json) ? peek.json.length : 0;
  const roster: AgentRow[] = res && Array.isArray(res.json) ? (res.json as AgentRow[]) : [];
  const active = roster.filter((a) => Date.now() - Date.parse(a.lastSeen) < 10 * 60_000);
  const names = roster
    .map((a) => a.name + (a.thisSession ? ' (this session)' : '') + (a.status ? ` [${a.status}]` : ''))
    .join(', ');

  const asks = roster.filter(
    (a) =>
      !a.thisSession && Date.now() - Date.parse(a.lastSeen) < 10 * 60_000 && /^(blocked|need|help)\b/i.test(a.status ?? ''),
  );
  const lines: (string | null)[] = [
    `agentcomm: this repo is on a message bus${bus ? ` (${bus})` : ''}.`,
    alias ? `You are registered as ${alias} — bare commands use this alias automatically.` : null,
    pending ? `${pending} message(s) already waiting for you — run \`agentcomm inbox --json\` first.` : null,
    roster.length
      ? `Roster: ${roster.length} agent(s)${active.length ? `, ${active.length} active in the last 10m` : ''} — ${names}.`
      : 'Roster: empty — you would be the first to register.',
    ...asks.map(
      (a) =>
        `call to action — ${a.name} is asking: "${a.status}". If you can answer from what you already know, reply: \`agentcomm send ${a.name} "<answer>" --subject status\`.`,
    ),
    // Claude Code mirrors the task list into status (TaskCreated hooks);
    // Codex has no task events, so only the explicit form is advertised.
    isClaude()
      ? 'Your status shows on the shared board — it auto-follows your task list (TaskCreate), or set it explicitly: `agentcomm register --status "<short task>"`; "blocked: <need>" recruits help.'
      : 'Your status shows on the shared board — set it with `agentcomm register --status "<short task>"`; "blocked: <need>" recruits help.',
    'To coordinate: `agentcomm send <to> <msg>` / `inbox --json` / `wait`; `agentcomm conventions` has the rules, `agentcomm --help` the full command set.',
  ];

  // Telemetry semantic layer (issue #100): deterministic facts are captured by
  // hooks; outcomes only the model can judge are self-reported — inject the
  // repo's record: instructions so the agent knows what to `emit` and when.
  try {
    const track = (await loadConventions(cwd))?.telemetry?.track ?? [];
    const recs = track.filter((r) => r.record);
    if (recs.length) {
      lines.push(
        'Telemetry (repo opt-in via .agentcomm config): hooks record tracked events automatically; ' +
          'YOU self-report the outcomes below when they happen, with `agentcomm emit`:',
      );
      for (const r of recs.slice(0, 6)) {
        const name = r.match ? ` --name ${r.match}` : '';
        lines.push(
          `  - after ${r.on}${r.match ? ` "${r.match}"` : ''}: record ${r.record} — ` +
            `\`agentcomm emit --type ${r.on}-outcome${name} --ref "$(git branch --show-current)" --attrs '{"…":"…"}'\``,
        );
      }
    }
  } catch {
    /* fail open — telemetry must never block a session */
  }

  // "Update available" nudge — once a day, network-capped, fails open.
  try {
    const note = await updateNotice(isClaude() ? 'claude' : 'codex');
    if (note) lines.push(note);
  } catch {
    /* fail open */
  }

  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: lines.filter(Boolean).join('\n') },
    }),
  );
}

// ── stop-guard ──────────────────────────────────────────────────────────────

async function hookStopGuard(input: HookInput): Promise<void> {
  if (input.stop_hook_active) return;
  const cwd = input.cwd || process.cwd();
  if (!(await onTheBus(cwd))) return;

  // throttle: a git-backend peek is a fetch; don't pay it on every quick turn
  const stamp = path.join(os.tmpdir(), `agentcomm-stopguard-${cwdKey(cwd)}`);
  try {
    const st = await fs.stat(stamp);
    if (Date.now() - st.mtimeMs < 45_000) return;
  } catch {
    /* first check */
  }

  const res = await cli(['peek', '--json'], cwd);
  await fs.writeFile(stamp, '').catch(() => {});
  if (!res || !Array.isArray(res.json) || res.json.length === 0) return;

  const msgs = res.json as LogMsg[];
  const alias = aliasFrom(res.stderr) ?? 'this session';
  const from = [...new Set(msgs.map((m) => m.from))].join(', ');
  process.stdout.write(
    JSON.stringify({
      decision: 'block',
      reason:
        `agentcomm delivery (working as intended — not an error): ${msgs.length} unread bus message(s) ` +
        `for ${alias} (from: ${from}). Read them with \`agentcomm inbox --json\`, act or tell the user why not, ` +
        'then finish.',
    }),
  );
}

// ── prompt-digest ───────────────────────────────────────────────────────────

async function hookPromptDigest(input: HookInput): Promise<void> {
  const cwd = input.cwd || process.cwd();
  if (!(await onTheBus(cwd))) return;

  const id = cwdKey(cwd);
  const stamp = path.join(os.tmpdir(), `agentcomm-digest-${id}`);
  const rosterFile = path.join(os.tmpdir(), `agentcomm-digest-roster-${id}`);
  try {
    if (Date.now() - (await fs.stat(stamp)).mtimeMs < 5 * 60_000) return;
  } catch {
    /* first digest */
  }

  // Heartbeat rides the digest (~5min); a plain register keeps the existing
  // status (statuses come from the task list or explicit declaration, never
  // from a heartbeat).
  await cli(['register', '--json'], cwd, 3_000);
  const peek = await cli(['peek', '--json'], cwd, 3_000);
  const agents = await cli(['agents', '--json'], cwd, 3_000);
  await fs.writeFile(stamp, '').catch(() => {});
  if (!peek && !agents) return;

  const pending = Array.isArray(peek?.json) ? peek.json.length : 0;
  const roster: AgentRow[] = agents && Array.isArray(agents.json) ? (agents.json as AgentRow[]) : [];
  const names = roster.map((a) => a.name).sort();
  let known: string[] = [];
  let knownStatuses: Record<string, string> = {};
  try {
    const snap = JSON.parse(await fs.readFile(rosterFile, 'utf8')) as
      | string[]
      | { names?: string[]; statuses?: Record<string, string> };
    if (Array.isArray(snap)) known = snap; // pre-0.14.2 snapshot shape
    else {
      known = snap.names ?? [];
      knownStatuses = snap.statuses ?? {};
    }
  } catch {
    /* no snapshot yet */
  }
  const statuses = Object.fromEntries(roster.filter((a) => a.status).map((a) => [a.name, a.status!]));
  await fs
    .writeFile(rosterFile, JSON.stringify({ names, statuses: { ...knownStatuses, ...statuses } }))
    .catch(() => {});
  const joined = known.length ? names.filter((n) => !known.includes(n)) : [];
  const alias0 = aliasFrom(peek?.stderr);
  // a status CHANGE is news in itself — "X started doing Y" must reach the
  // others within one digest cycle, not wait for unrelated traffic
  const statusChanges = known.length
    ? roster.filter((a) => a.status && a.name !== alias0 && knownStatuses[a.name] !== a.status)
    : [];
  const activeAgents = roster.filter((a) => Date.now() - Date.parse(a.lastSeen) < 10 * 60_000);
  // status adoption: an agent with no declared status is invisible to
  // coordination — nudge it (gently: at most once per 30min per repo)
  let statusNudge: string | null = null;
  const myRec = roster.find((a) => a.name === alias0);
  if (myRec && !myRec.status) {
    const nudgeStamp = path.join(os.tmpdir(), `agentcomm-nudge-${id}`);
    let due = true;
    try {
      due = Date.now() - (await fs.stat(nudgeStamp)).mtimeMs > 30 * 60_000;
    } catch {
      /* first */
    }
    if (due) {
      statusNudge =
        'You have no bus status — set one so teammates see your work: `agentcomm register --status "<short task>"` (it also auto-follows your task list). "blocked: <need>" recruits help.';
      await fs.writeFile(nudgeStamp, '').catch(() => {});
    }
  }
  const { lines: activity } = await activitySince(cwd, alias0, path.join(os.tmpdir(), `agentcomm-digest-acts-${id}`), 4);

  const alias = alias0 ?? 'you';
  const bits: string[] = [];
  const ctas: string[] = [];
  if (pending) bits.push(`${pending} unread message(s) for ${alias} — \`agentcomm inbox --json\``);
  if (joined.length)
    bits.push(
      `new on the bus: ${joined.join(', ')} — if your work overlaps, introduce yourself (\`agentcomm send ${joined[0]} "<what you're on>" --subject status\`)`,
    );
  const isAsk = (t: string | undefined) => /^(blocked|need|help)\b/i.test(t ?? '');
  const asks = activeAgents.filter((a) => a.name !== alias0 && isAsk(a.status));
  const changed = statusChanges.filter((a) => !isAsk(a.status));
  if (changed.length)
    bits.push(`now working — ${changed.slice(0, 4).map((a) => `${a.name}: ${a.status}`).join(' · ')}`);
  const withStatus = activeAgents
    .filter((a) => a.status && !isAsk(a.status) && !changed.some((c) => c.name === a.name))
    .map((a) => `${a.name}: ${a.status}`);
  if (withStatus.length) bits.push(`working — ${withStatus.slice(0, 4).join(' · ')}`);
  bits.push(`${activeAgents.length}/${roster.length} agents active`);
  for (const a of asks.slice(0, 3)) {
    ctas.push(
      `call to action — ${a.name} is asking: "${a.status}". If you can answer from what you ` +
        `already know, reply now: \`agentcomm send ${a.name} "<answer>" --subject status\` ` +
        '(check `agentcomm log --limit 10` first — it may already be answered). ' +
        'Otherwise continue your own task.',
    );
  }
  if (!pending && joined.length === 0 && ctas.length === 0 && activity.length === 0 && statusChanges.length === 0 && !statusNudge)
    return; // no news, no noise

  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'UserPromptSubmit',
        additionalContext:
          `agentcomm digest: ${bits.join(' · ')}.` +
          (activity.length ? `\nbus activity since last digest:\n  ${activity.join('\n  ')}` : '') +
          (ctas.length ? `\n${ctas.join('\n')}` : '') +
          (statusNudge ? `\n${statusNudge}` : ''),
      },
    }),
  );
}

// ── midturn-digest ──────────────────────────────────────────────────────────

async function hookMidturnDigest(input: HookInput): Promise<void> {
  const cwd = input.cwd || process.cwd();

  // throttle stamp — the settings.json sh guard checks THIS file's age (~5ms)
  // before the CLI ever spawns, so key derivation must match it exactly:
  // sanitized CLAUDE_PROJECT_DIR (fallback cwd), non-alnum → _
  const stampDirKey = (process.env.CLAUDE_PROJECT_DIR ?? cwd).replace(/[^A-Za-z0-9]/g, '_');
  const stamp = path.join(os.tmpdir(), `agentcomm-midturn-${stampDirKey}`);
  try {
    if (Date.now() - (await fs.stat(stamp)).mtimeMs < 10 * 60_000) return;
  } catch {
    /* first check */
  }
  if (!(await onTheBus(cwd))) return;
  await fs.writeFile(stamp, '').catch(() => {});

  await cli(['register', '--json'], cwd, 3_000); // mid-turn heartbeat: hour-long work stays visible
  const peek = await cli(['peek', '--json'], cwd, 3_000);
  const agents = await cli(['agents', '--json'], cwd, 3_000);

  const pending = Array.isArray(peek?.json) ? peek.json.length : 0;
  const roster: AgentRow[] = agents && Array.isArray(agents.json) ? (agents.json as AgentRow[]) : [];
  const me = aliasFrom(peek?.stderr);
  const asks = roster.filter(
    (a) =>
      a.name !== me && Date.now() - Date.parse(a.lastSeen) < 10 * 60_000 && /^(blocked|need|help)\b/i.test(a.status ?? ''),
  );
  const { lines: activity } = await activitySince(
    cwd,
    me,
    path.join(os.tmpdir(), `agentcomm-midturn-acts-${stampDirKey}`),
    3,
  );
  if (!pending && asks.length === 0 && activity.length === 0) return;

  const lines: string[] = [];
  if (activity.length) lines.push(`agentcomm (mid-task) bus activity FYI:\n  ${activity.join('\n  ')}`);
  if (pending)
    lines.push(
      `agentcomm (mid-task): ${pending} unread message(s) for ${me ?? 'you'} — if it may affect the current work, \`agentcomm inbox --json\` now; otherwise finish first (the stop guard will hold it).`,
    );
  for (const a of asks.slice(0, 2))
    lines.push(
      `agentcomm (mid-task): ${a.name} is asking: "${a.status}" — reply only if you can answer from what you already know (\`agentcomm send ${a.name} "<answer>" --subject status\`); do not derail the current task.`,
    );

  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: lines.join('\n') },
    }),
  );
}

// ── task-status ─────────────────────────────────────────────────────────────

async function hookTaskStatus(input: HookInput): Promise<void> {
  const cwd = input.cwd || process.cwd();
  if (!(await onTheBus(cwd))) return;

  const subject = (input.task_subject ?? '').trim();
  if (!subject) return;

  const status = input.hook_event_name === 'TaskCompleted' ? `done: ${subject}` : subject;
  const clipped = status.length > 80 ? status.slice(0, 79) + '…' : status;

  await cli(['register', '--status-auto', clipped], cwd, 3_000);
}

// ── telemetry ───────────────────────────────────────────────────────────────

async function hookTelemetry(input: HookInput): Promise<void> {
  const cwd = input.cwd || process.cwd();
  if (!(await onTheBus(cwd))) return;

  let track: { on: string; match?: string; record?: string }[] = [];
  try {
    track = (await loadConventions(cwd))?.telemetry?.track ?? [];
  } catch {
    /* no config / unreadable → not opted in */
  }
  if (track.length === 0) return;

  /** Exact or simple-glob ('thermo-*') rule matching against a name. */
  const nameMatches = (pattern: string | undefined, name: string | undefined): boolean => {
    if (!pattern) return true;
    if (pattern === name) return true;
    if (!pattern.includes('*')) return false;
    const re = new RegExp(
      '^' + pattern.split('*').map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$',
    );
    return re.test(name ?? '');
  };
  const tracked = (on: string, name?: string) => track.some((r) => r.on === on && nameMatches(r.match, name));

  /** hook payload → the event to record, or null when nothing is tracked. */
  const deriveEvent = (): { type: string; name?: string; attrs?: object; flush?: boolean } | null => {
    const hook = input.hook_event_name;
    if (hook === 'PostToolUse' && input.tool_name === 'Skill') {
      const skill = input.tool_input?.skill ?? input.tool_input?.name;
      if (skill && tracked('skill', skill)) return { type: 'skill-ran', name: skill };
      return null;
    }
    // Subagent spawns (the Task/Agent tool). Skills that a repo runs as
    // dedicated subagents — or that set disable-model-invocation and are
    // therefore invisible to the Skill tool — are only observable here.
    if (hook === 'PostToolUse' && (input.tool_name === 'Task' || input.tool_name === 'Agent')) {
      const subagent = input.tool_input?.subagent_type;
      if (subagent && tracked('agent', subagent)) return { type: 'agent-ran', name: subagent };
      return null;
    }
    if (hook === 'PostToolUse' && input.tool_name === 'Bash') {
      const command = String(input.tool_input?.command ?? '');
      if (/(^|[\s;&|(])git\s+merge\b/.test(command) || /(^|[\s;&|(])gh\s+pr\s+merge\b/.test(command)) {
        if (tracked('merge')) {
          return { type: 'merged', attrs: { command: command.length > 120 ? command.slice(0, 119) + '…' : command } };
        }
      }
      return null;
    }
    if (hook === 'SessionStart' && tracked('session')) return { type: 'session-start' };
    // session end is the last chance to ship — flush instead of waiting for a ride
    if (hook === 'SessionEnd' && tracked('session')) return { type: 'session-end', flush: true };
    if ((hook === 'TaskCompleted' || hook === 'TaskCreated') && input.task_subject) {
      const subject = String(input.task_subject).trim();
      if (subject && tracked('task', subject)) {
        return { type: hook === 'TaskCompleted' ? 'task-completed' : 'task-created', name: subject.slice(0, 120) };
      }
      return null;
    }
    return null;
  };

  const event = deriveEvent();
  if (!event) return;

  const ref = await new Promise<string | null>((resolve) =>
    execFile('git', ['-C', cwd, 'branch', '--show-current'], (err, out) => resolve(err ? null : out.trim() || null)),
  );

  await cli(
    [
      'emit',
      '--type',
      event.type,
      ...(event.name ? ['--name', event.name] : []),
      ...(ref ? ['--ref', ref] : []),
      ...(event.attrs ? ['--attrs', JSON.stringify(event.attrs)] : []),
      ...(event.flush ? ['--flush'] : []),
      '--json',
    ],
    cwd,
    event.flush ? 20_000 : 5_000,
  );
}

// ── dispatch ────────────────────────────────────────────────────────────────

const HANDLERS: Record<string, (input: HookInput) => Promise<void>> = {
  'session-start': hookSessionStart,
  'stop-guard': hookStopGuard,
  'prompt-digest': hookPromptDigest,
  'midturn-digest': hookMidturnDigest,
  'task-status': hookTaskStatus,
  telemetry: hookTelemetry,
};

/** Entry point for `agentcomm hook <event>`: stdin JSON in, hook JSON out, exit 0 always. */
export async function runHook(event: string | undefined): Promise<number> {
  const handler = event ? HANDLERS[event] : undefined;
  if (!handler) {
    process.stderr.write(`agentcomm: unknown hook event "${event ?? ''}" (one of: ${Object.keys(HANDLERS).join(', ')})\n`);
    return 1;
  }
  try {
    const input = await readStdinJson();
    await handler(input);
  } catch {
    /* hooks fail open — never break a session */
  }
  return 0;
}
