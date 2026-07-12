/**
 * agentcomm OpenCode plugin.
 *
 * Wires the agentcomm bus lifecycle onto OpenCode's plugin events, reusing the
 * exact same hook scripts (hooks/*.mjs) that back the Claude Code and Codex
 * plugins — so behavior stays identical and single-sourced.
 *
 * Mapping (verified against @opencode-ai/plugin):
 *   event "session.created" → session-start.mjs   (register + brief)
 *   event "session.idle"    → stop-inbox-guard.mjs (unread-mail guard)
 *   "tool.execute.after"    → midturn-digest.mjs   (long-turn reachability)
 *
 * OpenCode injection is pull-based (the `experimental.chat.system.transform`
 * hook mutates the system prompt) and idle is observe-only (no veto), so:
 *   - hook `additionalContext` is buffered and injected on the next turn.
 *   - a stop-guard `decision:block` becomes a best-effort re-prompt, since
 *     OpenCode can't hold a session open the way Claude/Codex can.
 */
import type { Plugin } from '@opencode-ai/plugin';
import { spawn } from 'node:child_process';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
// dist/ and hooks/ are synced next to this plugin (see scripts/sync-plugins.mjs)
const pluginRoot = path.resolve(here, '..');

/** Run a bundled hook script with synthesized stdin; return its parsed JSON output (or null). */
function runHook(script: string, stdin: object, cwd: string): Promise<Record<string, unknown> | null> {
  return new Promise((resolve) => {
    let out = '';
    const child = spawn(process.execPath, [path.join(pluginRoot, 'hooks', script)], {
      cwd,
      stdio: ['pipe', 'pipe', 'ignore'],
      // PLUGIN_ROOT lets the hook find dist/cli.js; a stable session seed keeps
      // the extension's derived alias aligned with the agent's own CLI calls.
      env: { ...process.env, PLUGIN_ROOT: pluginRoot },
    });
    child.stdout.on('data', (d) => (out += d.toString()));
    child.on('error', () => resolve(null));
    child.on('close', () => {
      try {
        resolve(out.trim() ? (JSON.parse(out) as Record<string, unknown>) : null);
      } catch {
        resolve(null);
      }
    });
    child.stdin.end(JSON.stringify(stdin));
  });
}

function contextOf(res: Record<string, unknown> | null): string | null {
  const hso = res?.hookSpecificOutput as { additionalContext?: string } | undefined;
  return hso?.additionalContext ?? null;
}

export const AgentcommPlugin: Plugin = async ({ directory, client }) => {
  const cwd = directory;
  // Context the bus wants the model to see on its next turn (OpenCode pulls
  // system-prompt additions via system.transform rather than us pushing).
  const pending: string[] = [];

  return {
    async event({ event }) {
      try {
        if (event.type === 'session.created') {
          const ctx = contextOf(await runHook('session-start.mjs', { cwd, source: 'startup' }, cwd));
          if (ctx) pending.push(ctx);
        } else if (event.type === 'session.idle') {
          const res = await runHook('stop-inbox-guard.mjs', { cwd }, cwd);
          const reason = res?.decision === 'block' ? (res.reason as string) : null;
          if (reason) {
            // Can't veto idle — re-engage the session with the guard's reason.
            const sessionID = (event as { properties?: { sessionID?: string } }).properties?.sessionID;
            if (sessionID) {
              await client.session
                .prompt({ path: { id: sessionID }, body: { parts: [{ type: 'text', text: reason }] } })
                .catch(() => {});
            }
          }
        }
      } catch {
        /* fail open — a broken bus never wedges the session */
      }
    },

    async 'tool.execute.after'() {
      try {
        const ctx = contextOf(await runHook('midturn-digest.mjs', { cwd, tool_name: 'tool' }, cwd));
        if (ctx) pending.push(ctx);
      } catch {
        /* fail open */
      }
    },

    async 'experimental.chat.system.transform'(_input, output) {
      if (pending.length) {
        output.system.push(...pending.splice(0));
      }
    },
  };
};
