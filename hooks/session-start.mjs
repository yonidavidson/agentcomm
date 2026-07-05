#!/usr/bin/env node
/**
 * SessionStart hook: in a repo that opted onto the bus (CLAUDE.md marker
 * from `agentcomm init`, or AGENTCOMM_BACKEND), tell the agent — bus URI,
 * its derived session alias, and the live roster — before the first prompt.
 * Silent everywhere else; silent on any failure.
 */
import { readStdinJson, onTheBus, cli, busUriFrom, aliasFrom } from './lib.mjs';

const input = await readStdinJson();
const cwd = input.cwd || process.cwd();
if (!(await onTheBus(cwd))) process.exit(0);

// peek derives (and announces) the session alias and finds waiting mail;
// agents supplies the roster. Both read-only.
const peek = await cli(['peek', '--json'], cwd);
if (!peek) process.exit(0);
const res = await cli(['agents', '--json'], cwd);

const bus = busUriFrom(peek.stderr);
const alias = aliasFrom(peek.stderr);
const pending = Array.isArray(peek.json) ? peek.json.length : 0;
const roster = res && Array.isArray(res.json) ? res.json : [];
const fresh = roster.filter((a) => Date.now() - Date.parse(a.lastSeen) < 10 * 60_000);
const names = roster.map((a) => a.name + (a.thisSession ? ' (this session)' : '')).join(', ');

const lines = [
  `agentcomm: this repo is on a message bus${bus ? ` (${bus})` : ''}.`,
  alias ? `Your derived alias for this session: ${alias} — bare commands use it automatically.` : null,
  pending ? `${pending} message(s) already waiting for you — run \`agentcomm inbox --json\` first.` : null,
  roster.length
    ? `Roster: ${roster.length} agent(s)${fresh.length ? `, ${fresh.length} active in the last 10m` : ''} — ${names}.`
    : 'Roster: empty — you would be the first to register.',
  'When coordinating: `agentcomm register`, then `agentcomm inbox --json`; the agentcomm skill has the conventions.',
].filter(Boolean);

process.stdout.write(
  JSON.stringify({
    hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: lines.join('\n') },
  }),
);
