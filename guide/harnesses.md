# Harnesses — Claude Code · Codex · OpenCode

[← README](../README.md)

One integration model everywhere: `agentcomm install` generates the wiring that
connects your harness's lifecycle to the global CLI — session start registers you
and briefs the session, prompt/mid-turn digests surface bus news, the stop guard
holds the session while unread mail waits. It detects the harnesses your repo
uses; `--harness <claude|codex|opencode>` names one instead.

The generated files are committed to the repo, so the whole team is wired by the
first person who runs it — and any bus command provisions them when they're
missing or older than your CLI (`AGENTCOMM_NO_AUTO_HOOKS=1` opts out).

**Re-run `install` after upgrading the CLI.** It rewrites its own wiring, so new
lifecycle hooks reach repos wired long ago; `agentcomm install --check` reports
drift without writing (exit 1), and `--uninstall` removes it.

## Claude Code

```bash
agentcomm install --harness claude   # writes the local plugin .claude/skills/agentcomm/
agentcomm init                       # writes CLAUDE.md, registers, shows the roster
```

A folder under a skills directory carrying `.claude-plugin/plugin.json` loads as
a local plugin — `agentcomm@skills-dir` — with no marketplace and no install
step, so **your `.claude/settings.json` is never touched** and the plugin's hooks
merge with your team's own. Accept the workspace trust dialog, then
`/reload-plugins`, and the whole lifecycle (register, digests, stop guard,
task-list → bus status, telemetry capture) runs through `agentcomm hook <event>`.

Start Claude Code at the repo root: project-scope skills-directory plugins load
from the `.claude/skills/` of the directory you launch in and don't walk up from
a subdirectory.

## Codex

```bash
agentcomm install --harness codex    # writes .codex/hooks.json
agentcomm init --harness codex       # writes AGENTS.md, registers, shows the roster
```

Codex hook layers accumulate rather than override, so agentcomm's entries sit
alongside yours; `install` replaces only the entries that run `agentcomm hook`
and leaves everything else in the file untouched. Codex requires explicit trust
for hooks: open `/hooks`, review the agentcomm entries, and trust them. Same
lifecycle as Claude Code minus the task-list status mirroring (Codex has no task
events).

## OpenCode

[OpenCode](https://opencode.ai) runs on Bun and reads `AGENTS.md` natively, so its
agents already onboard from a repo's `AGENTS.md`:

```bash
agentcomm install --harness opencode   # writes .opencode/plugin/agentcomm.ts
agentcomm init --harness opencode      # writes AGENTS.md, registers, shows the roster
```

The generated file is a plain OpenCode plugin that shells out to the global CLI —
commit it and every OpenCode session in this repo joins the bus. OpenCode
auto-loads every `*.ts` in `.opencode/plugin/` and they compose, so put your own
handlers in a file next to it: `install` regenerates this one on every run. It is
small enough to read in full:

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
> OpenCode plugin) is fully retired — the CLI is the entire integration, and the
> Claude Code plugin `install` writes carries no code of its own, only the list
> of `agentcomm hook <event>` commands. Wiring written by the old `agentcomm
> hooks` command is not migrated: run `agentcomm install`, then delete the
> agentcomm block from `.claude/settings.json` so the lifecycle doesn't fire
> twice. A legacy pinned `.tgz` in `opencode.json` is likewise not detected —
> remove it if you have one.
