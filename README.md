# agentcomm

🌐 **[Website](https://yonidavidson.github.io/agentcomm/)** · [Use cases](https://yonidavidson.github.io/agentcomm/#use-cases) · [Live demo — an agent conversation that *is* a git branch](https://github.com/yonidavidson/agentcomm/tree/agentcomm)

A tiny mailbox for AI agents. Agents `register`, `send`, and read their `inbox`
through one CLI; a single `Backend` interface hides where the messages live.
**In a git repo you are already on the bus** — the repo's remote is the transport,
no server, no config, no dependencies.

## Install

```bash
npm install -g @yonidavidson/agentcomm
agentcomm install                    # wires every harness this repo uses
agentcomm init                       # writes the team contract, registers you, shows the roster
```

`install` wires the harness lifecycle to the CLI (auto-register at session start,
inbox digests, the stop guard) — a local plugin for Claude Code and OpenCode, a
hooks file for Codex; `init` writes the coordination contract into `CLAUDE.md`
(Claude Code) or `AGENTS.md` (everyone else). Any bus command provisions the
wiring when it's missing or older than your CLI, so the `install` step is usually
optional. Re-run it after upgrading: it rewrites its own wiring, which is how new
lifecycle hooks reach a repo wired months ago. `agentcomm version` tells you when
to upgrade.

~100 kB, zero runtime dependencies for the file/git backends. Published to the
npm registry with build provenance — that is the whole distribution story.

## Quick start

```bash
# in a git repo: zero config. You're on the repo bus under a session-unique alias.
agentcomm init                      # → acting as yoni-3f2a · on the bus: git+ssh://…
agentcomm agents                    # who's here: yoni-3f2a · dana-97b1 · ci-bot
agentcomm send ci-bot "hold deploys" --subject status

# named ROLES (addressable, stable) take --as
agentcomm register --as reviewer
agentcomm send reviewer "review src/auth.ts" --subject task --thread auth-1
agentcomm inbox --as reviewer --json            # consumes; archives under read/
agentcomm wait  --as reviewer --timeout 30000   # exit 0 on delivery, 2 on timeout

# one queue, many workers (git + SQL backends)
agentcomm send work-queue "task-1" --subject task
agentcomm claim --queue work-queue --as worker-1   # atomic; null when empty
```

`send`/`broadcast` take the body from the trailing argument or from **stdin**:
`echo "from a pipe" | agentcomm send bob`.

## Commands

| Command            | What it does                                                   |
| ------------------ | -------------------------------------------------------------- |
| `init`             | Put this repo on the bus; writes `CLAUDE.md` (or `AGENTS.md` with `--harness`). |
| `register`         | Register / heartbeat the calling agent, optionally with `--status`. |
| `agents`           | List registered agents.                                        |
| `send <to> [body]` | Send a message (body from arg or stdin).                       |
| `broadcast [body]` | Send to every registered agent except yourself.                |
| `inbox`            | **Consume** undelivered messages; archives them under `read/`.  |
| `peek`             | Show undelivered messages **without** consuming.               |
| `wait`             | Block until a message arrives (**exit 0**) or timeout (**exit 2**). |
| `claim`            | Atomically dequeue one message from `--queue` (git + SQL backends). |
| `log`              | Read a channel's conversation, time-ordered and non-consuming.  |
| `network`          | Situation report: who's on the bus, their status, recent traffic. |
| `channels`         | List the channels that already exist on a store.               |
| `describe`         | Explain a backend scheme and its capabilities. Never connects.  |
| `conventions`      | Print the effective team conventions. Never connects.          |
| `purge`            | Delete archived mail (`--older-than`) and, opt-in, telemetry events (`--events`). |
| `emit` / `events`  | Write and read the [telemetry lane](guide/telemetry.md).        |
| `version` / `-v`   | Installed vs latest release; prints the upgrade command.        |

Key flags: `--backend <uri>` (transport), `--as <name>` (acting alias, env
`AGENTCOMM_AGENT`), `--subject` / `--thread`, `--timeout`, `--queue`, `--json`
(every command). `agentcomm <cmd> --help` has the rest.

Backend resolution: `--backend` > `AGENTCOMM_BACKEND` > `.agentcomm` config >
`git+<origin>` probe > `github://` token fallback > `file://./.agentcomm`.

## Backends

Choose transport by **topology** — that's the only fork that matters.
One machine → `sqlite://`. Across machines → `postgres://`. In a git repo → you
already have one.

| Backend     | URI                          | Driver (optional)      | Atomic `move` | `claim` | Push (`wait`) | Use when                         |
| ----------- | ---------------------------- | ---------------------- | :-----------: | :-----: | :-----------: | -------------------------------- |
| **Local**   | `file:///path/dir`, bare dir | — (built in)           | ✅ rename     | ❌      | poll          | dev, single process, zero deps   |
| **Git (any host)** | `git+ssh://…/repo.git` | — (git binary)       | ✅ one commit | ✅ push CAS | poll     | **any git remote** — GitLab, Gitea, private servers |
| **GitHub**  | `github://owner/repo`        | — (built in)           | ❌ copy+commit | ❌     | poll          | token-mode GitHub variant (CI, API-only) |
| **SQLite**  | `sqlite:///path.db`, `*.db`  | `better-sqlite3`       | ✅ txn        | ✅ txn  | poll          | **single machine** (recommended) |
| **S3**      | `s3://bucket/prefix`         | `@aws-sdk/client-s3`   | ❌ copy+del   | ❌      | poll          | shared object store              |
| **GCS**     | `gs://bucket/prefix`         | `@google-cloud/storage`| ❌ copy+del   | ❌      | poll          | shared object store              |
| **Postgres**| `postgres://…/db`            | `pg`                   | ✅ txn        | ✅ `SKIP LOCKED` | ✅ **push** | **across machines/containers** |

One store hosts many isolated channels, carved from the URI
(`s3://bucket/team-a`, `…?channel=team-a`). On network buses a background daemon
serves reads from a warm mirror, so calls answer immediately.
→ [Backends in depth](guide/backends.md)

## Going further

- [**Harnesses**](guide/harnesses.md) — Claude Code, Codex, and OpenCode wiring; what the generated hooks do.
- [**Backends**](guide/backends.md) — the daemon, channels, naming conventions, URI grammar, repo pointers, housekeeping.
- [**Telemetry**](guide/telemetry.md) — the opt-in append-only event lane and what it answers.
- [**Library use**](guide/sdk.md) — the SDK, optional drivers, and writing your own backend plugin.
- [**Design**](guide/design.md) — the key layout on the store, and the constraints that are deliberate.
- [**Contributing**](CONTRIBUTING.md) — dev setup, the seven-backend test matrix, releasing.
- [**agentcomm-arcade**](https://github.com/yonidavidson/agentcomm-arcade) — a dashboard on the bus; the worked example for building your own UI.

## License

MIT © Yoni Davidson
