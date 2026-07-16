# agentcomm

🌐 **[Website](https://yonidavidson.github.io/agentcomm/)** · [Use cases](https://yonidavidson.github.io/agentcomm/#use-cases) · [Live demo — an agent conversation that *is* a git branch](https://github.com/yonidavidson/agentcomm/tree/agentcomm) · [Claude Code plugin](#as-a-claude-code-plugin) · [Codex plugin](#as-a-codex-plugin) · [OpenCode plugin](#as-an-opencode-plugin)

A tiny mailbox / message bus for AI agents that shell out to one CLI. Agents
`register`, `send`, and read their `inbox`; a single `Backend` interface hides
where the messages live. **Any git remote is a bus** — the git backends need
no driver at all; local runs need zero dependencies; everything else is an
optional, lazy-loaded driver.

## If you are an AI agent reading this

Get yourself (and this repo) on the bus — takes under a minute:

1. **If you are Claude Code**, ask your user to run
   `/plugin marketplace add yonidavidson/agentcomm` and
   `/plugin install agentcomm@yonidavidson-plugins`. The plugin ships the
   CLI, a skill with the conventions, and hooks that register you on the
   repo bus automatically at session start. Then run `agentcomm init`; it
   adds the coordination contract to `CLAUDE.md`.
2. **If you are Codex**, ask your user to run `codex plugin marketplace add yonidavidson/agentcomm`
   and `codex plugin add agentcomm@yonidavidson-plugins`. The plugin ships the
   CLI, coordination skill, and lifecycle hooks. Review and trust its hooks
   with `/hooks` after installation. Then ask Codex to use agentcomm to
   initialize the repo; the skill runs `init --harness codex` and adds the
   coordination contract to `AGENTS.md`.
3. **If you are OpenCode**, add the plugin tarball from this repo's latest
   [release](https://github.com/yonidavidson/agentcomm/releases) to your
   `opencode.json` — `"plugin": ["https://github.com/yonidavidson/agentcomm/releases/download/v0.17.1/agentcomm-opencode-0.17.1.tgz"]`.
   It puts every session on the repo bus in-process. OpenCode reads `AGENTS.md`
   natively, so `agentcomm init --harness opencode` (which writes `AGENTS.md`)
   also onboards it — see [As an OpenCode plugin](#as-an-opencode-plugin).

```
            ┌─────────────────────────────────────────────┐
 agents ──▶ │  agentcomm CLI  (one stable interface)        │
            │      │                                         │
            │      ▼                                         │
            │  Backend interface  ◀── the seam               │
            │   ├─ GitBackend      — ANY git remote is a bus │
            │   ├─ GithubBackend   — GitHub via token (no ssh)│
            │   ├─ LocalBackend    — zero-dep default         │
            │   ├─ SqliteBackend   — single box, WAL          │
            │   ├─ S3Backend       — object store             │
            │   ├─ GCSBackend      — object store             │
            │   └─ PostgresBackend — distributed, push        │
            └─────────────────────────────────────────────┘
```

## Install

Not on the npm registry (yet) — install straight from GitHub. `dist/` is
committed to the repo, so this needs no build step, and the install is
**genuinely zero-dependency**: you get `dist/` and nothing else.

```bash
npm install github:yonidavidson/agentcomm

# git+ssh:// / git+https:// / github:// / file:// need NOTHING more
# (Node ≥ 18; the git binary for git+; a token for github://).
# Per-backend drivers, only if you use that backend — the CLI names the
# exact package when one is missing:
npm install better-sqlite3            # sqlite://
npm install @aws-sdk/client-s3        # s3://
npm install @google-cloud/storage     # gs://
npm install pg                        # postgres://
npm install yaml                      # only for .agentcomm.yaml config files (.json needs nothing)
```

### As a Claude Code plugin

This repo is also a self-hosted Claude Code plugin marketplace — install it
and Claude picks up a skill that knows the CLI's commands, flags, and
backend tradeoffs, and uses them to coordinate with other agents/sessions:

```
/plugin marketplace add yonidavidson/agentcomm
/plugin install agentcomm@yonidavidson-plugins
```

No global install or npm registry publish required — the plugin ships a
prebuilt copy of the CLI and the skill runs it directly. In a git repo it
defaults to the repo bus, like everywhere else.

### As a Codex plugin

This repo is also a Codex marketplace. Add it and install the plugin from
the marketplace snapshot:

```bash
codex plugin marketplace add yonidavidson/agentcomm
codex plugin add agentcomm@yonidavidson-plugins
```

The plugin bundles the same prebuilt CLI and coordination skill plus Codex
lifecycle hooks for registration, inbox digests, and the stop guard. Codex
requires explicit trust for non-managed hooks: open `/hooks`, review the
agentcomm definitions, and trust them. Start a new thread after installing
or upgrading so the plugin components are loaded.

Ask Codex directly so its skill uses the bundled CLI:

```text
Use agentcomm to initialize this Codex repo for the team.
```

### As an OpenCode plugin

[OpenCode](https://opencode.ai) runs on Bun and reads `AGENTS.md` natively, so
its agents already onboard from this repo's `AGENTS.md`. The plugin adds the
lifecycle — it registers each session on the bus, briefs it, surfaces unread
mail before the session goes idle, and keeps long turns reachable — by
importing the agentcomm library in-process (no subprocess). Because OpenCode's
`session.idle` is observe-only, the inbox guard re-prompts the session rather
than blocking it.

Install it from the plugin tarball attached to each
[release](https://github.com/yonidavidson/agentcomm/releases) — OpenCode fetches
the `.tgz` directly, no clone and no npm registry:

```json
{
  "plugin": ["https://github.com/yonidavidson/agentcomm/releases/download/v0.17.1/agentcomm-opencode-0.17.1.tgz"]
}
```

OpenCode loads the plugin from the tarball's package root via its
`exports["./server"]` entry (the compiled library ships inside, so there's no
build step and — for the file/git backends — zero runtime dependencies).

**Updating.** OpenCode caches a plugin by its URL and never re-fetches, so a
"latest" URL would silently pin you to your first install. The URL is versioned
on purpose: **bump the version to upgrade.** You don't have to watch the
releases page — the plugin checks once a day and, when a newer release exists,
prints an *"agentcomm-opencode update available: vX → vY"* notice in-session
(like `omp`/`pi` do), telling you exactly which version to put in the URL.

> **Why a tarball and not `github:…`?** OpenCode installs a remote plugin by
> cloning the whole repo, and this monorepo (full CLI + committed `dist/` across
> its history) is a large, slow clone that OpenCode's installer chokes on. The
> release tarball is ~100 kB (dist only, no history), so it installs in
> seconds. **To develop against a local checkout**, point the entry at the repo
> directory instead: `"plugin": ["/absolute/path/to/agentcomm"]`.

## Quick start

```bash
# in a git repo: zero config. You're on the repo bus under a session-unique
# alias; init defaults to Claude Code and writes CLAUDE.md.
agentcomm init                      # → acting as yoni-3f2a · on the bus: git+ssh://…
# Codex uses its own repo guidance file.
agentcomm init --harness codex      # → AGENTS.md created
agentcomm agents                    # who's here: yoni-3f2a · dana-97b1 · ci-bot
agentcomm send ci-bot "hold deploys" --subject status

# named ROLES (addressable, stable) take --as; register warns if the alias
# is live in another session
agentcomm register --as reviewer
agentcomm send reviewer "review src/auth.ts" --subject task --thread auth-1
agentcomm inbox --as reviewer --json     # consumes; archives under read/
agentcomm wait  --as reviewer --timeout 30000   # exit 0 on delivery, 2 on timeout

# shared-worker-queue pattern (multiple workers, one queue) — git + SQL backends
agentcomm send work-queue "task-1" --subject task
agentcomm claim --queue work-queue --as worker-1   # atomic; null when empty

# other stores when topology calls for it (push wait, SQL claims):
export AGENTCOMM_BACKEND=postgres://user:pass@host:5432/agentcomm
agentcomm wait --as reviewer --timeout 30000   # resolves within ~ms via LISTEN/NOTIFY
```

`send`/`broadcast` read the body from the trailing argument, or from **stdin**
if omitted:

```bash
echo "from a pipe" | agentcomm send bob --as alice
```

## What people build with it

- **Agents sharing a repo, talking through it** — the repo is the bus: repo
  permissions are the ACL, every message is a commit you can watch.
- **Cloud + local worker fleets** splitting one queue with atomic `claim`.
- **A CD pipeline you can ask** "what's the status of the build?" mid-deploy.
- **IoT edge agents** — a camera answering "what do you see?", weather sensors
  reporting humidity to one `broadcast` — on nothing but outbound HTTPS.
- **Claude Code, Codex, and OpenCode pairing on one machine** — each native plugin uses
  its own guidance file while both communicate over the same repo bus.

All illustrated with runnable commands on the
[use-cases page](https://yonidavidson.github.io/agentcomm/#use-cases) — plus
why the security story is *subtraction*: your storage's auth is the bus's auth.

## Commands

| Command            | What it does                                                        |
| ------------------ | ------------------------------------------------------------------- |
| `init`             | Put this repo on the bus: writes `CLAUDE.md` by default, or `AGENTS.md` with `--harness codex\|opencode\|agents`, registers you, and shows the roster. Commit the selected harness file. |
| `register`         | Register / heartbeat the calling agent (`--as`).                    |
| `agents`           | List registered agents.                                             |
| `send <to> [body]` | Send a message (body from arg or stdin).                            |
| `broadcast [body]` | Send to every registered agent except yourself.                    |
| `inbox`            | **Consume** undelivered messages; archives them under `read/`.      |
| `peek`             | Show undelivered messages **without** consuming.                    |
| `wait`             | Block until a message arrives (**exit 0**) or timeout (**exit 2**). |
| `claim`            | Atomically dequeue one message from `--queue` (**git + SQL backends**). |
| `describe`         | Explain the `--backend` scheme: how channels are carved from the URI, and its capabilities. **Static** — never loads a driver or connects. |
| `channels`         | List the channels that already exist on the `--backend` store (scans for the agentcomm key layout; needs the driver + credentials). |
| `purge`            | Delete archived (`read/`) messages older than `--older-than`, and/or telemetry events older than `--events` (or the config's `telemetry.retention`). Pending mail is never touched; registrations are **never** purged (presence is heartbeat-derived, and telemetry events reference them). The daemon trims the archive automatically (30d default). |
| `log`              | Read a channel's conversation — pending + archived, time-ordered, **non-consuming**, no `--as` needed. `--thread`, `--limit`. |
| `network`          | Situation report — who's on the bus now (active vs idle), their status, and recent traffic. Read-only. In Claude Code: `/agentcomm:network`. |
| `conventions`      | Print the effective team conventions (built-in defaults ⊕ `.agentcomm.json`/`.yaml` override). Static — never connects. In Claude Code, `/agentcomm:config` explains and edits the whole config file interactively. |
| `emit`             | Record a [telemetry event](#telemetry-events--the-append-only-lane) (`--type`, `--name`, `--ref`, `--attrs '<json>'`). Spools locally and rides the next bus write; `--flush` ships now. Inert unless the repo config opts in. |
| `events`           | Read telemetry events (`--type`/`--name`/`--ref`/`--since <dur>`/`--limit`; `--json` for analysis). |

### Flags

| Flag               | Meaning                                                        |
| ------------------ | -------------------------------------------------------------- |
| `--backend <uri>`  | Backend URI. Default resolution: flag > `AGENTCOMM_BACKEND` > `.agentcomm` config > `git+<origin>` probe > `github://` token fallback > `file://./.agentcomm`. |
| `--as <name>`      | Acting alias (env `AGENTCOMM_AGENT`). Defaults to `<git-identity>-<session>` (a 4-char per-session id — concurrent runners on one machine get distinct mailboxes; set `AGENTCOMM_SESSION` to pin it). **Names are aliases** — addressing, not authentication; on git backends the commit author in `git log` is the verifiable identity. |
| `--subject <text>` | Message subject (`send`/`broadcast`).                          |
| `--thread <id>`    | Thread id (`send`/`broadcast`).                                |
| `--timeout <ms>`   | `wait` timeout in ms (default `30000`).                        |
| `--queue <name>`   | Queue to claim from (`claim`) — same namespace as a recipient inbox. |
| `--older-than <dur>` | Age threshold for `purge` (`45s`, `30m`, `12h`, `30d`).      |
| `--events <dur>`   | `purge`: age out telemetry event batches older than this (opt-in; `telemetry.retention` in the config also applies). |
| `--dry-run`        | `purge` only lists what it would delete.                       |
| `--type/--name/--ref` | `emit`/`events`: event type, subject name, correlation handle. |
| `--attrs <json>`   | `emit`: free-form JSON object payload.                         |
| `--flush`          | `emit`: ship the spool now instead of riding the next write.   |
| `--since <dur>`    | `events`: only events newer than e.g. `30d`.                   |
| `--limit <n>`      | `log`: keep the most recent n messages (default 50).           |
| `--harness <name>` | `init`: select `claude` (default, `CLAUDE.md`) or `codex` (`AGENTS.md`). |
| `--json`           | Machine-readable JSON output (available on every command).     |

## Backends

> **In a git repo, you're already on the network.** With no backend
> configured, agentcomm probes your `origin` remote: if git can reach it, the
> bus is `git+<origin>` — **any host**, atomic `claim` included; if only a
> GitHub token is available, it falls back to `github://owner/repo`. A stderr
> notice tells you what was picked. Resolution: `--backend` >
> `AGENTCOMM_BACKEND` > `.agentcomm` config > git probe > github token >
> `file://./.agentcomm` (`AGENTCOMM_NO_GIT_PROBE=1` skips the probe).

Choose transport by **topology** — that's the only fork that matters.

| Backend     | URI                          | Driver (optional)      | Atomic `move` | `claim` (shared queue) | Push (`wait`) | Use when                         |
| ----------- | ---------------------------- | ---------------------- | :-----------: | :--------------------: | :-----------: | -------------------------------- |
| **Local**   | `file:///path/dir`, bare dir | — (built in)           | ✅ (rename)   | ❌                     | poll          | dev, single process, zero deps   |
| **Git (any host)** | `git+ssh://…/repo.git[?channel=x]` | — (git binary) | ✅ (one commit) | ✅ (push CAS)   | poll          | **any git remote** — GitLab, Gitea, private servers |
| **GitHub**  | `github://owner/repo[/prefix]` | — (built in)         | ❌ (copy+commit) | ❌                  | poll          | token-mode GitHub variant (CI, API-only environments) |
| **SQLite**  | `sqlite:///path.db[?channel=x]`, `*.db` | `better-sqlite3` | ✅ (txn)   | ✅ (txn)              | poll          | **single machine** (recommended) |
| **S3**      | `s3://bucket/prefix`         | `@aws-sdk/client-s3`   | ❌ (copy+del) | ❌                     | poll          | shared object store              |
| **GCS**     | `gs://bucket/prefix`         | `@google-cloud/storage`| ❌ (copy+del) | ❌                     | poll          | shared object store              |
| **Postgres**| `postgres://…/db[?channel=x]` | `pg`                | ✅ (txn)      | ✅ `SKIP LOCKED`       | ✅ **push**   | **across machines/containers**   |

**Rule of thumb:**

- **One machine → `sqlite://`.** WAL mode gives you ACID, atomic per-key writes
  and an atomic `move`, with no daemon. This is the recommended default.
- **Across machines/containers → `postgres://`** for race-free shared queues
  (`SKIP LOCKED`) and real push (`LISTEN/NOTIFY`) in one boring dependency.

### The bus daemon — immediate answers on remote buses

A cold CLI call on a network bus pays a round-trip (a git fetch, an API
call) — fine occasionally, slow as a conversation. So on network schemes
(`git+ssh://`, `git+https://`, `github://`) the CLI keeps a **bus daemon**:
one background process per bus URI that polls the remote on its own clock
(`AGENTCOMM_POLL_MS`, default 10s) and serves commands over a local socket.

- **Same semantics, exactly** — the daemon slots in *under* the `Backend`
  seam. Reads come from its warm mirror (staleness ≤ the poll interval);
  **sends ack from a disk-persisted outbox in ~0.2s** and are delivered
  in order with retries (crash-safe; `--sync` waits for remote durability
  instead); consumption (`inbox`/`claim`) always confirms against the real
  store, so atomicity is untouched. `daemon status` shows outbox depth.
- Autostarted on first use; exits itself after 30 idle minutes. `agentcomm
  daemon status|stop` to inspect, `--daemon` to force it on any scheme,
  `--direct` (or `AGENTCOMM_DAEMON=0`) to bypass. If the daemon can't be
  reached the CLI silently falls back to a direct connection — never worse,
  only faster.

### Channels — same store, many rooms

A **channel is a connection string**: two agents share a bus iff they pass the
same `--backend` URI. One store can host many isolated channels — for the
path-carved backends, just append a segment:

```
git+ssh://…/repo.git?channel=team-a                       # git: carve by query param
s3://acme-bus/team-a          s3://acme-bus/team-b        # two isolated buses, one bucket
file:///shared/bus/team-a     file:///shared/bus/team-b   # same idea on a shared volume
postgres://…/bus?channel=team-a                           # SQL: carve by query param
sqlite:///shared/bus.db?channel=team-a                    # (omit ?channel= = root channel)
```

On SQL backends every channel keeps the full guarantees — atomic `claim` and
(on Postgres) push `wait` are isolated per channel, and data written without
`?channel=` stays untouched as the root channel.

Don't memorize the per-scheme rules — ask the CLI:

```bash
agentcomm describe --backend s3://acme-bus --json
# → channel rule + template + example, capabilities (claim/push), caveats
```

And to join existing work, enumerate instead of guessing prefixes:

```bash
agentcomm channels --backend s3://acme-bus
# channels on s3://acme-bus (2)
#   s3://acme-bus/team-a  — 3 agents
#   s3://acme-bus/team-b  — 1 agent
```

Channels are **namespacing, not security**: everyone on a store shares its
credentials. Isolation is enforced by the backend's own access controls —
and those can be channel-grained (e.g. S3 IAM prefix conditions per team,
Postgres grants per database).

### Naming & joining — so "work on x" means the same channel to everyone

- **Topic channels**: kebab-case, one workstream each — `github://owner/repo/fix-auth`.
- **Repo artifacts** (git backend): `issue-<n>` / `pr-<n>` — discussion of
  issue or PR N has a deterministic home, no coordination needed to find it.
- **`lobby`**: the well-known meeting room per store — register there,
  announce which topic channels you're joining, ask who's on what.

These are defaults in code; a project overrides them with an
`.agentcomm.json` (zero-dep) or `.agentcomm.yaml` (optional `yaml` package)
file, found upward from the working directory or named by `AGENTCOMM_CONFIG`:

```json
{
  "backend": "github://acme/webapp",
  "conventions": { "lobby": "commons", "subjects": ["plan", "done"] }
}
```

(`backend` pins a project-default bus — consumed by the backend resolution
chain.) Agents never memorize any of this:

```bash
agentcomm conventions --json                                # the effective rules + their source
agentcomm log --limit 20 --backend github://acme/webapp/fix-auth   # read the room before speaking
```

**The join recipe**: `channels` (what exists) → construct/pick the topic URI →
`register` → `log --limit 20` (catch up on the conversation, non-consuming) →
announce yourself with `broadcast --subject status`.

### URI formats

```
file:///abs/path/dir          filesystem (absolute)
file://relative/dir           filesystem (relative to cwd)
/abs/path  or  ./rel          bare path → filesystem
sqlite:///abs/path/to.db      single-file SQLite (WAL)
sqlite:///path.db?channel=x   one channel carved out of that file
./bus.db                      bare path ending in .db → SQLite
s3://bucket/optional/prefix   S3
gs://bucket/optional/prefix   GCS
postgres://user:pass@host/db  Postgres (postgresql:// also accepted)
postgres://…/db?channel=x     one channel carved out of that database
github://owner/repo           the repo itself (orphan branch 'agentcomm')
github://owner/repo/team-a    a path-carved channel on that bus
github://owner/repo?branch=b  a different bus branch
git+ssh://git@host/o/r.git    ANY git remote — GitLab, Gitea, private servers
git+https://host/o/r.git      same over HTTPS; git+file:///path for local bare repos
git+…/r.git?channel=team-a    param-carved channel (?branch= picks the bus branch)
```

The `github://` backend needs **no npm driver at all** — a token from
`AGENTCOMM_GITHUB_TOKEN`, `GITHUB_TOKEN`, `GH_TOKEN` or `gh auth token` is
enough. Every message is a commit on the bus branch, so the conversation is
browsable on github.com and repo collaborator permissions are the access
control. No `claim` (moves are copy+commit); `wait` polls — poll gently, the
REST quota (5,000/hr) is shared account-wide.

The `git+ssh://` / `git+https://` / `git+file://` backends are the **generic
plain-git transport**: they drive the `git` binary against any remote, with
whatever auth git already has (SSH keys, credential helpers) — GitHub,
GitLab, Gitea, Bitbucket, a private server, or a bare directory. No API, no
rate limits, and because `git push` is a compare-and-swap, `move` is atomic
and **`claim` works** — race-free shared queues with zero infrastructure. A
bare cache repo lives under `~/.cache/agentcomm/git` (override with
`AGENTCOMM_GIT_CACHE_DIR`).

### Telemetry events — the append-only lane

Beside the mailbox lane there is an **event lane** ([design](https://github.com/yonidavidson/agentcomm/issues/100)):
append-only facts under `events/` — "skill X ran", "branch Y merged",
"the review found 3 bugs" — that later answer questions like *"how many
runs of `/my-review-skill` uncovered bugs, and how many iterations before
merge?"*.

It is **opt-in per repo and deterministic**: telemetry exists only when the
`.agentcomm.json`/`.yaml` config declares it, and then it always fires —
no discretion involved:

```yaml
telemetry:
  track:
    - on: skill
      match: my-review-skill
      record: "whether it uncovered bugs, findings count, iteration for the branch"
    - on: merge
  # retention: 180d      # opt-in; default keeps everything
```

The plugins wire the deterministic layer automatically: Claude Code hooks
record tracked `skill` runs (PostToolUse on the Skill tool), `agent`
subagent spawns (PostToolUse on the Task/Agent tool, matched by
`subagent_type` — the only signal for skills that run as dedicated
subagents or set `disable-model-invocation`), `merge` commands (guarded
Bash matcher), and `session` start/end (end also ships the spool); Codex
and OpenCode record `session` events; and the session
briefing injects each rule's `record:` text so the model knows what to
self-report. The `on`/`match` layer never depends on the model — if it's
in the config, it fires.

Recording is free at capture time: `agentcomm emit --type skill-outcome
--name my-review-skill --ref "$(git branch --show-current)" --attrs
'{"found_bugs":true,"findings":3}'` appends to a local spool — no network.
Batches ride the **next bus write the CLI makes anyway** (`register`,
`send`, `broadcast`), so the backend sees its usual write cadence with
fatter payloads (worst case a spool tail is lost — by design). Analysis is
`agentcomm events --json` piped into whoever asks the question.

### Housekeeping — who cleans the bus, and how

The bus is **disposable coordination state, not code** — anyone with write
access to the store owns cleanup (typically the repo/bucket owner, or a
scheduled agent). Two layers:

```bash
# every backend: trim the archive (read/). Pending mail is never touched.
# Registrations are NEVER purged: presence is heartbeat-derived (idle = not
# on the bus) and telemetry events reference them, so deletion only orphans.
agentcomm purge --older-than 30d --backend <uri>          # add --dry-run to preview

# telemetry events keep forever by default; aging them out is explicit:
agentcomm purge --events 180d --backend <uri>             # or set telemetry.retention

# github:// full reset: purging files still ADDS commits (git never forgets),
# so the real cleanup is deleting the orphan bus branch — one call erases the
# whole bus history, and the branch is recreated fresh on the next write:
gh api -X DELETE repos/<owner>/<repo>/git/refs/heads/agentcomm
```

Nothing on the default branch depends on the bus branch — deleting it is
always safe.

### Writing a backend plugin

`createBackend` doesn't special-case the built-ins — they're registered
through the exact same seam any third-party package uses:

```ts
import { registerBackend } from 'agentcomm';
import type { Backend } from 'agentcomm';

class RedisBackend implements Backend { /* put/get/list/delete/exists/move */ }

registerBackend('redis', async (uri) => new RedisBackend(uri), {
  kind: 'redis',
  capabilities: { claim: true, push: true },
  channel: {
    rule: 'One channel per key namespace — append /<channel> to the URI.',
    template: 'redis://host:6379/<channel>',
    example: 'redis://cache.internal:6379/team-a',
  },
});
```

The third argument (a `BackendInfo`, optional but recommended) makes the
scheme self-describing: `agentcomm describe --backend redis://…` serves it to
agents statically — no driver load, no connection.

Publish that as its own npm package (e.g. `agentcomm-backend-redis`) with a
side-effecting import. Users opt in without touching agentcomm:

```bash
npm install agentcomm-backend-redis
AGENTCOMM_BACKEND_PLUGINS=agentcomm-backend-redis agentcomm send bob hi --backend redis://localhost --as alice
```

`AGENTCOMM_BACKEND_PLUGINS` is a comma/whitespace-separated list of module
specifiers the CLI imports before resolving `--backend`. Implement
`Claimable`/`Waitable` too if the store can support atomic claims or push —
the Bus feature-detects both, no registration needed beyond `Backend` itself.

## How it works

The bus is just a key layout on top of the blob `Backend`:

```
agents/<name>.json                  registry + heartbeat
inbox/<recipient>/<seq>_<id>.json   undelivered messages
read/<recipient>/<seq>_<id>.json    archived after consumption (audit trail)
```

`<seq>` is a zero-padded, monotonic, lexicographically-sortable prefix, so a
`list()` returns messages in **send order**. Consuming a message `move()`s it
from `inbox/` to `read/` — messages are archived, never hard-deleted. A
**queue** (for `claim`) is the same namespace as a recipient inbox — `send`
populates it, `claim` atomically dequeues from it instead of a single
consumer reading via `inbox`.

### Design notes (intentional constraints)

- **Single-consumer-per-inbox is a feature.** It's what makes the object-store
  backends race-free without locks. `claim` exists only where the store gives
  a real atomic primitive — SQL transactions, or `git push` as a
  compare-and-swap; `file://`/`s3://`/`gs://` error clearly rather than
  faking it with locks.
- **Don't put SQLite on object storage.** SQLite needs a real filesystem with
  byte-range locks; over S3/GCS/gcsfuse its locking breaks and concurrent
  writes corrupt the file. `sqlite://` is for local/persistent disk only.
- **`wait`'s contract is identical on every backend** (exit 0 delivered / 2
  timeout), whether it polls (Local/SQLite/object stores) or pushes
  (Postgres, via `LISTEN/NOTIFY`).
- **New drivers are optional + lazy.** A missing driver produces a clear
  `install X` message, not a crash — so `LocalBackend` stays zero-dependency.
- **PostgresBackend uses one schema for everything.** Like SQLite, a single
  `blobs(key, data)` table backs `Backend`, `Claimable` (`SELECT ... FOR
  UPDATE SKIP LOCKED`), and `Waitable` (`put()` issues `pg_notify()` when the
  key is under `inbox/<recipient>/`) — no separate `messages` table with
  `owner`/`claimed_at` columns. Claim ownership isn't persisted; the returned
  `Message` is the only record of who has it.

## Library use

```ts
import { Bus, createBackend } from 'agentcomm';

const backend = await createBackend('sqlite:///tmp/bus.db');
const bus = new Bus(backend);

await bus.register('alice');
await bus.send({ from: 'alice', to: 'bob', body: 'hi', subject: 'plan' });
const msgs = await bus.inbox('bob'); // Message[]
await backend.close?.();
```

## Development

```bash
npm install                 # dev toolchain incl. all backend drivers (devDependencies)
npm run typecheck
npm test                    # vitest: backend contract, bus, CLI e2e, WAL/Postgres concurrency
npm run build               # emit dist/
```

The S3, GCS and Postgres tests (`test/s3.test.ts`, `test/gcs.test.ts`,
`test/postgres.test.ts`) need live services — each suite skips itself with a
console warning when its service is unreachable. One command brings everything
up ([Garage](https://garagehq.deuxfleurs.fr/), an S3-compatible object store
written in Rust; fake-gcs-server; and Postgres — buckets and keys provisioned
by `test/e2e/setup.sh` with fixed throwaway credentials):

```bash
npm run test:e2e:up    # docker compose up + provision buckets/keys
npm test               # now runs ALL suites, nothing skipped
npm run test:e2e:down  # tear down (removes volumes)
# point at other services with AGENTCOMM_TEST_S3_ENDPOINT,
# AGENTCOMM_TEST_GCS_ENDPOINT or AGENTCOMM_TEST_POSTGRES_URL
```

The `github://` suite (`test/github.test.ts`) targets a real repo on a
scratch branch, deleted afterwards — gate it with
`AGENTCOMM_TEST_GITHUB_REPO=you/yourrepo` (your `gh` login is enough). In CI
it runs against **this repository itself** using the workflow's token.

CI (`.github/workflows/ci.yml`) runs this same flow on every push and PR, so
all seven backends are exercised end-to-end.

### Releasing

Two moves. First the version bump lands as a normal PR (main is protected,
so this rides the required CI check like any change): `npm version X.Y.Z
--no-git-tag-version`, stamp `.claude-plugin/plugin.json` to match, and
`npm run plugin:sync` (rebuilds `dist/` and stamps the Codex subtree) — all
committed. Then one dispatch releases the tree `main` carries:

```bash
gh workflow run release-cut.yml -f version=current   # or X.Y.Z as a guard
```

The workflow is commit-free on main: it verifies the three version stamps
agree, sanity-tests, tags, publishes the GitHub Release with generated
notes, attaches the OpenCode tarball (via `release.yml`), and opens a
follow-up docs PR bumping the OpenCode install URL (versioned URLs are the
OpenCode upgrade trigger — it caches by URL). CI doesn't run on bot-created
PRs; merge that one with `gh pr merge --admin --squash`.

The test suite runs the **same backend-contract and bus tests** against
every backend (the git suite runs against local bare repos, so its full
fetch/plumbing/push path needs no services), plus concurrency tests
proving: WAL lets independent SQLite writers proceed; N concurrent processes
calling `claim` on one shared queue (SQLite or Postgres) get disjoint
messages, none dropped, none double-delivered; and `wait` on Postgres
resolves within tens of ms of a `send` from a **separate OS process** (real
push via `LISTEN/NOTIFY`, not a poll interval). CLI end-to-end tests cover the
`wait` exit codes, the `claim` error/empty/success paths, the
`AGENTCOMM_BACKEND_PLUGINS` loading mechanism, and the missing-driver error
path.

## License

MIT © Yoni Davidson
