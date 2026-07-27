# Harnesses — Claude Code · Codex · OpenCode

[← README](../README.md)

One integration model everywhere: `agentcomm hooks --harness <name>` generates
the file that wires your harness's lifecycle to the global CLI — session start
registers you and briefs the session, prompt/mid-turn digests surface bus news,
the stop guard holds the session while unread mail waits.

The generated files are committed to the repo, so the whole team is wired by the
first person who runs it — and any bus command auto-provisions them when they're
missing (`AGENTCOMM_NO_AUTO_HOOKS=1` opts out).

## Claude Code

```bash
agentcomm hooks --harness claude     # writes hooks into .claude/settings.json
agentcomm init                       # writes CLAUDE.md, registers, shows the roster
```

The hooks merge into existing project settings without touching anything else.
Claude Code asks once to approve project hooks — accept, and the whole lifecycle
(register, digests, stop guard, task-list → bus status, telemetry capture) runs
through `agentcomm hook <event>`.

## Codex

```bash
agentcomm hooks --harness codex      # writes .codex/hooks.json
agentcomm init --harness codex       # writes AGENTS.md, registers, shows the roster
```

Codex requires explicit trust for hooks: open `/hooks`, review the agentcomm
entries, and trust them. Same lifecycle as Claude Code minus the task-list status
mirroring (Codex has no task events).

## OpenCode

[OpenCode](https://opencode.ai) runs on Bun and reads `AGENTS.md` natively, so its
agents already onboard from a repo's `AGENTS.md`:

```bash
agentcomm hooks --harness opencode     # writes .opencode/plugin/agentcomm.ts
agentcomm init --harness opencode      # writes AGENTS.md, registers, shows the roster
```

The generated file is a plain OpenCode plugin that shells out to the global CLI —
commit it and every OpenCode session in this repo joins the bus. It is small
enough to read in full, and yours to edit:

```ts
// .opencode/plugin/agentcomm.ts (generated — abridged)
import type { Plugin } from '@opencode-ai/plugin';

export const AgentcommHooks: Plugin = async ({ directory, client, $ }) => {
  const sh = $.cwd(directory).nothrow();

  // Session start: join the repo bus under a session-unique alias.
  await sh`agentcomm register --status "opencode session"`.quiet();

  return {
    // session.idle can't block, so unread mail re-prompts the session.
    async event({ event }) {
      if (event.type !== 'session.idle') return;
      const peek = await sh`agentcomm peek --json`.quiet();
      // …parses the inbox and re-prompts the session when mail is waiting…
    },
    // Telemetry parity with the other harnesses: tool events are normalized
    // and handed to `agentcomm hook telemetry`, which owns the repo's
    // telemetry.track rule matching; dispose() ships the event spool.
    async 'tool.execute.after'(input) {
      // …skill / task / bash(merge) → agentcomm hook telemetry…
    },
    async dispose() {
      // …agentcomm emit --flush…
    },
  };
};
```

That same shape is how you'd wire any other hook to the bus — e.g. a handler that
`agentcomm send`s a teammate when a long task finishes. (OpenCode's
`session.idle` can't block, so its inbox guard nudges instead of holding the
session the way the Claude Code stop guard does.)

> An earlier plugin system (Claude Code/Codex marketplaces, an in-process
> OpenCode plugin) is fully retired — the CLI is the entire integration. A legacy
> pinned `.tgz` in `opencode.json` keeps working and suppresses hook generation,
> but new setups use the commands above.
