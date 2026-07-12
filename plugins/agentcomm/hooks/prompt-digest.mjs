#!/usr/bin/env node
/**
 * UserPromptSubmit hook: the bus digest. At most once per 5 minutes — and
 * only when there is NEWS (pending mail, or riders that joined since the
 * last digest) — inject a one-line status into the turn's context. Silent
 * otherwise; silent on any failure; hard time budget so the prompt path
 * never stalls.
 */
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { readStdinJson, onTheBus, cli, aliasFrom, activitySince } from './lib.mjs';

const input = await readStdinJson();
const cwd = input.cwd || process.cwd();
if (!(await onTheBus(cwd))) process.exit(0);

const id = createHash('sha1').update(cwd).digest('hex').slice(0, 12);
const stamp = path.join(os.tmpdir(), `agentcomm-digest-${id}`);
const rosterFile = path.join(os.tmpdir(), `agentcomm-digest-roster-${id}`);
try {
  if (Date.now() - (await fs.stat(stamp)).mtimeMs < 5 * 60_000) process.exit(0);
} catch { /* first digest */ }

// Heartbeat rides the digest (~5min); a plain register keeps the existing
// status (Bus preserves it — statuses come from the task list or explicit
// declaration, never from a heartbeat).
await cli(['register', '--json'], cwd, 3_000);
const peek = await cli(['peek', '--json'], cwd, 3_000);
const agents = await cli(['agents', '--json'], cwd, 3_000);
await fs.writeFile(stamp, '').catch(() => {});
if (!peek && !agents) process.exit(0);

const pending = Array.isArray(peek?.json) ? peek.json.length : 0;
const roster = agents && Array.isArray(agents.json) ? agents.json : [];
const names = roster.map((a) => a.name).sort();
let known = [];
let knownStatuses = {};
try {
  const snap = JSON.parse(await fs.readFile(rosterFile, 'utf8'));
  if (Array.isArray(snap)) known = snap; // pre-0.14.2 snapshot shape
  else {
    known = snap.names ?? [];
    knownStatuses = snap.statuses ?? {};
  }
} catch { /* no snapshot yet */ }
const statuses = Object.fromEntries(roster.filter((a) => a.status).map((a) => [a.name, a.status]));
await fs.writeFile(rosterFile, JSON.stringify({ names, statuses: { ...knownStatuses, ...statuses } })).catch(() => {});
const joined = known.length ? names.filter((n) => !known.includes(n)) : [];
// a status CHANGE is news in itself — "X started doing Y" must reach the
// others within one digest cycle, not wait for unrelated traffic
const statusChanges = known.length
  ? roster.filter(
      (a) => a.status && a.name !== aliasFrom(peek?.stderr) && knownStatuses[a.name] !== a.status,
    )
  : [];
const activeAgents = roster.filter((a) => Date.now() - Date.parse(a.lastSeen) < 10 * 60_000);
const alias0 = aliasFrom(peek?.stderr);
// status adoption: an agent with no declared status is invisible to
// coordination — nudge it (gently: at most once per 30min per repo)
let statusNudge = null;
const myRec = roster.find((a) => a.name === alias0);
// nudge only when truly statusless (no task list, no declaration)
if (myRec && !myRec.status) {
  const nudgeStamp = path.join(os.tmpdir(), `agentcomm-nudge-${id}`);
  let due = true;
  try {
    due = Date.now() - (await fs.stat(nudgeStamp)).mtimeMs > 30 * 60_000;
  } catch { /* first */ }
  if (due) {
    statusNudge = process.env.PLUGIN_ROOT
      ? 'You have no bus status — set one so teammates see your work: `agentcomm register --status "<short task>"`. "blocked: <need>" recruits help.'
      : 'You have no bus status — set one so teammates see your work: `agentcomm register --status "<short task>"` (it also auto-follows your task list). "blocked: <need>" recruits help.';
    await fs.writeFile(nudgeStamp, '').catch(() => {});
  }
}
const { lines: activity } = await activitySince(
  cwd,
  alias0,
  path.join(os.tmpdir(), `agentcomm-digest-acts-${id}`),
  4,
);

// (asks computed below also count as news)

const alias = aliasFrom(peek?.stderr) ?? 'you';
const bits = [];
const ctas = [];
if (pending) bits.push(`${pending} unread message(s) for ${alias} — \`agentcomm inbox --json\``);
if (joined.length)
  bits.push(
    `new on the bus: ${joined.join(', ')} — if your work overlaps, introduce yourself (\`agentcomm send ${joined[0]} "<what you're on>" --subject status\`)`,
  );
const isAsk = (t) => /^(blocked|need|help)\b/i.test(t ?? '');
const asks = activeAgents.filter((a) => a.name !== aliasFrom(peek?.stderr) && isAsk(a.status));
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
if (
  !pending &&
  joined.length === 0 &&
  ctas.length === 0 &&
  activity.length === 0 &&
  statusChanges.length === 0 &&
  !statusNudge
)
  process.exit(0); // no news, no noise

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
