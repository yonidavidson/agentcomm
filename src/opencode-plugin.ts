/**
 * agentcomm OpenCode plugin — exposed from the package root so OpenCode can
 * install it straight from GitHub:
 *
 *   { "plugin": ["github:yonidavidson/agentcomm"] }
 *
 * OpenCode resolves a `server` plugin via the package's `exports["./server"]`
 * (see package.json), which points here. No npm-registry publish and no local
 * checkout required — OpenCode installs the repo through npm's own installer.
 *
 * Puts every OpenCode session on the agentcomm bus: registers + briefs at
 * start, surfaces unread mail before the session goes idle, and keeps long
 * autonomous turns reachable — the same behavior the Claude Code and Codex
 * plugins provide.
 *
 * OpenCode runs on Bun, so this imports the agentcomm library directly and
 * calls the bus in-process rather than spawning the Node hook scripts.
 * Verified against @opencode-ai/plugin:
 *   - `opencode run` emits NO `session.created` — so register+brief happens in
 *     the factory body (which OpenCode calls per project, with the directory).
 *   - context injection is pull-based via `experimental.chat.system.transform`.
 *   - `session.idle` is observe-only (no veto) — the inbox guard degrades to a
 *     best-effort re-prompt, since OpenCode can't hold a session open.
 * Everything fails open: a broken bus never wedges the session.
 */
import type { Plugin } from '@opencode-ai/plugin';
import { openBusSession, sessionStartContext, inboxGuardReason, midTurnContext, type BusSession } from './index.js';
import { updateNotice } from './update-check.js';

export const AgentcommPlugin: Plugin = async ({ directory, client }) => {
  // Context the bus wants the model to see on its next turn (OpenCode pulls
  // system-prompt additions via system.transform rather than us pushing).
  const pending: string[] = [];
  let session: BusSession | null = null;

  // OpenCode calls the factory per project with the directory; register + brief
  // here since `session.created` never fires in `run` mode.
  try {
    session = await openBusSession(directory);
    if (session) {
      const ctx = await sessionStartContext(session);
      if (ctx) pending.push(ctx);
    }
  } catch {
    /* fail open */
  }

  // omp-style "Update Available" nudge — independent of the bus (throttled to
  // once a day, network-capped, fails open). OpenCode caches the tarball by URL,
  // so the only way users learn a new release exists is if we tell them.
  try {
    const note = await updateNotice('opencode');
    if (note) pending.push(note);
  } catch {
    /* fail open */
  }

  return {
    async event({ event }) {
      if (!session || event.type !== 'session.idle') return;
      try {
        const reason = await inboxGuardReason(session);
        if (reason) {
          // Can't veto idle — re-engage the session with the guard's reason.
          const sessionID = (event as { properties?: { sessionID?: string } }).properties?.sessionID;
          if (sessionID) {
            await client.session
              .prompt({ path: { id: sessionID }, body: { parts: [{ type: 'text', text: reason }] } })
              .catch(() => {});
          }
        }
      } catch {
        /* fail open */
      }
    },

    async 'tool.execute.after'() {
      if (!session) return;
      try {
        const ctx = await midTurnContext(session);
        if (ctx) pending.push(ctx);
      } catch {
        /* fail open */
      }
    },

    async 'experimental.chat.system.transform'(_input, output) {
      if (pending.length) output.system.push(...pending.splice(0));
    },

    async dispose() {
      await session?.close().catch(() => {});
    },
  };
};

export default AgentcommPlugin;
