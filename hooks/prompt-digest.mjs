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
import { readStdinJson, onTheBus, cli, aliasFrom } from './lib.mjs';

const input = await readStdinJson();
const cwd = input.cwd || process.cwd();
if (!(await onTheBus(cwd))) process.exit(0);

const id = createHash('sha1').update(cwd).digest('hex').slice(0, 12);
const stamp = path.join(os.tmpdir(), `agentcomm-digest-${id}`);
const rosterFile = path.join(os.tmpdir(), `agentcomm-digest-roster-${id}`);
try {
  if (Date.now() - (await fs.stat(stamp)).mtimeMs < 5 * 60_000) process.exit(0);
} catch { /* first digest */ }

// Heartbeat rides the digest: a prompt is the strongest "this session is
// alive" signal, and both want the same ~5min cadence. register is async
// through the daemon outbox, so this costs ~0.3s. No --status: a heartbeat
// never overwrites a declared status.
await cli(['register', '--json'], cwd, 3_000);
const peek = await cli(['peek', '--json'], cwd, 3_000);
const agents = await cli(['agents', '--json'], cwd, 3_000);
await fs.writeFile(stamp, '').catch(() => {});
if (!peek && !agents) process.exit(0);

const pending = Array.isArray(peek?.json) ? peek.json.length : 0;
const roster = agents && Array.isArray(agents.json) ? agents.json : [];
const names = roster.map((a) => a.name).sort();
let known = [];
try {
  known = JSON.parse(await fs.readFile(rosterFile, 'utf8'));
} catch { /* no snapshot yet */ }
await fs.writeFile(rosterFile, JSON.stringify(names)).catch(() => {});
const joined = known.length ? names.filter((n) => !known.includes(n)) : [];
const activeAgents = roster.filter((a) => Date.now() - Date.parse(a.lastSeen) < 10 * 60_000);

if (!pending && joined.length === 0) process.exit(0); // no news, no noise

const alias = aliasFrom(peek?.stderr) ?? 'you';
const bits = [];
if (pending) bits.push(`${pending} unread message(s) for ${alias} — \`agentcomm inbox --json\``);
if (joined.length) bits.push(`new on the bus: ${joined.join(', ')}`);
const withStatus = activeAgents.filter((a) => a.status).map((a) => `${a.name}: ${a.status}`);
if (withStatus.length) bits.push(`working — ${withStatus.slice(0, 4).join(' · ')}`);
bits.push(`${activeAgents.length}/${roster.length} agents active`);

process.stdout.write(
  JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'UserPromptSubmit',
      additionalContext: `agentcomm digest: ${bits.join(' · ')}.`,
    },
  }),
);
