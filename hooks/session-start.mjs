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

// The CLAUDE.md contract says agents register at session start — the hook
// does it (heartbeat onto the roster), throttled so restarts don't spam
// bus commits, then reports waiting mail and the roster.
import('node:fs');
const { promises: fsp } = await import('node:fs');
const { tmpdir } = await import('node:os');
const { createHash } = await import('node:crypto');
const { join } = await import('node:path');
const stamp = join(tmpdir(), `agentcomm-register-${createHash('sha1').update(cwd).digest('hex').slice(0, 12)}`);
let fresh = false;
try {
  fresh = Date.now() - (await fsp.stat(stamp)).mtimeMs < 10 * 60_000;
} catch { /* never registered from here */ }

const reg = fresh ? null : await cli(['register', '--json'], cwd, 20_000);
if (reg) await fsp.writeFile(stamp, '').catch(() => {});
const peek = await cli(['peek', '--json'], cwd);
if (!peek) process.exit(0);
const res = await cli(['agents', '--json'], cwd);

const bus = busUriFrom(peek.stderr) ?? busUriFrom(reg?.stderr);
const alias = aliasFrom(peek.stderr) ?? reg?.json?.name;
const pending = Array.isArray(peek.json) ? peek.json.length : 0;
const roster = res && Array.isArray(res.json) ? res.json : [];
const active = roster.filter((a) => Date.now() - Date.parse(a.lastSeen) < 10 * 60_000);
const names = roster.map((a) => a.name + (a.thisSession ? ' (this session)' : '')).join(', ');

const lines = [
  `agentcomm: this repo is on a message bus${bus ? ` (${bus})` : ''}.`,
  alias ? `You are registered as ${alias} — bare commands use this alias automatically.` : null,
  pending ? `${pending} message(s) already waiting for you — run \`agentcomm inbox --json\` first.` : null,
  roster.length
    ? `Roster: ${roster.length} agent(s)${active.length ? `, ${active.length} active in the last 10m` : ''} — ${names}.`
    : 'Roster: empty — you would be the first to register.',
  'To coordinate: `agentcomm send <to> <msg>` / `inbox --json` / `wait`; the agentcomm skill has the conventions.',
].filter(Boolean);

process.stdout.write(
  JSON.stringify({
    hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: lines.join('\n') },
  }),
);
