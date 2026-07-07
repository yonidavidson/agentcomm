#!/usr/bin/env node
/**
 * PostToolUse hook: the mid-turn digest. During LONG autonomous turns the
 * prompt/stop hooks never fire, so a busy agent would be deaf to the bus
 * for an hour. This fires with every tool call but exits in ~ms unless
 * 10 minutes have passed; when due, it heartbeats and surfaces ONLY
 * actionable signals (unread mail, active asks) next to the tool result.
 * Quiet bus → total silence. Any failure → silence.
 */
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { readStdinJson, onTheBus, cli, aliasFrom } from './lib.mjs';

const input = await readStdinJson();
const cwd = input.cwd || process.cwd();

// throttle FIRST — this path runs on every tool call and must be ~free
const id = createHash('sha1').update(cwd).digest('hex').slice(0, 12);
const stamp = path.join(os.tmpdir(), `agentcomm-midturn-${id}`);
try {
  if (Date.now() - (await fs.stat(stamp)).mtimeMs < 10 * 60_000) process.exit(0);
} catch { /* first check */ }
if (!(await onTheBus(cwd))) process.exit(0);
await fs.writeFile(stamp, '').catch(() => {});

await cli(['register', '--json'], cwd, 3_000); // mid-turn heartbeat: hour-long work stays visible
const peek = await cli(['peek', '--json'], cwd, 3_000);
const agents = await cli(['agents', '--json'], cwd, 3_000);

const pending = Array.isArray(peek?.json) ? peek.json.length : 0;
const roster = agents && Array.isArray(agents.json) ? agents.json : [];
const me = aliasFrom(peek?.stderr);
const asks = roster.filter(
  (a) =>
    a.name !== me &&
    Date.now() - Date.parse(a.lastSeen) < 10 * 60_000 &&
    /^(blocked|need|help)\b/i.test(a.status ?? ''),
);
if (!pending && asks.length === 0) process.exit(0);

const lines = [];
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
