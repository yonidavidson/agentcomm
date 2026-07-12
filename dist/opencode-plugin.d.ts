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
export declare const AgentcommPlugin: Plugin;
export default AgentcommPlugin;
//# sourceMappingURL=opencode-plugin.d.ts.map