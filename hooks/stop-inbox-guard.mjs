#!/usr/bin/env node
/**
 * Stop hook: "always check your inbox before reporting done", enforced.
 * In an opted-in repo, peek (non-consuming) at this session's derived
 * mailbox; pending mail blocks the stop once with a pointed reason.
 * Throttled (45s per cwd), loop-safe (stop_hook_active), fail-open.
 * Guards the derived session alias only — role aliases taken with --as
 * are the agent's own responsibility (the skill says so).
 */
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { readStdinJson, onTheBus, cli, aliasFrom } from './lib.mjs';

const input = await readStdinJson();
if (input.stop_hook_active) process.exit(0);
const cwd = input.cwd || process.cwd();
if (!(await onTheBus(cwd))) process.exit(0);

// throttle: a git-backend peek is a fetch; don't pay it on every quick turn
const stamp = path.join(os.tmpdir(), `agentcomm-stopguard-${createHash('sha1').update(cwd).digest('hex').slice(0, 12)}`);
try {
  const st = await fs.stat(stamp);
  if (Date.now() - st.mtimeMs < 45_000) process.exit(0);
} catch {
  /* first check */
}

const res = await cli(['peek', '--json'], cwd);
await fs.writeFile(stamp, '').catch(() => {});
if (!res || !Array.isArray(res.json) || res.json.length === 0) process.exit(0);

const alias = aliasFrom(res.stderr) ?? 'this session';
const from = [...new Set(res.json.map((m) => m.from))].join(', ');
process.stdout.write(
  JSON.stringify({
    decision: 'block',
    reason:
      `agentcomm: ${res.json.length} unread message(s) for ${alias} on the repo bus (from: ${from}). ` +
      'Run `agentcomm inbox --json`, act on them (or tell the user why not), then finish.',
  }),
);
