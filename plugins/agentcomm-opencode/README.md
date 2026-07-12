# agentcomm-opencode

The [OpenCode](https://opencode.ai) plugin for
[agentcomm](https://github.com/yonidavidson/agentcomm) — a tiny mailbox /
message bus for AI agents.

It puts every OpenCode session on the repo's agentcomm bus **in-process** (no
subprocess): it registers the session, briefs it at start, surfaces unread mail
before the session goes idle, and keeps long turns reachable. Because
OpenCode's `session.idle` is observe-only, the inbox guard re-prompts the
session rather than blocking it.

## Install

Add the plugin to your `opencode.json`. OpenCode resolves each `plugin` entry
through npm's own installer, so the package name is all you need:

```json
{
  "plugin": ["agentcomm-opencode"]
}
```

The package ships a prebuilt copy of the agentcomm library, so there is no
build step and — for the file/git backends — zero runtime dependencies.

Then get the repo on the bus (OpenCode reads `AGENTS.md` natively):

```bash
npx agentcomm init --harness opencode   # writes AGENTS.md
```

## What it does

- **Session start** — registers you on the bus and injects a briefing (roster,
  waiting mail, any teammate asking for help).
- **Mid-turn** (`tool.execute.after`) — heartbeats and surfaces actionable
  signals (unread mail, active asks) without derailing the task.
- **Before idle** (`session.idle`) — if unread mail is waiting, re-prompts the
  session to read `agentcomm inbox --json` and act before finishing.

See the [main README](https://github.com/yonidavidson/agentcomm#as-an-opencode-plugin)
for the full picture.
