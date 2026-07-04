---
description: Coordinate with other Claude Code agents or sessions via a shared mailbox CLI — register an identity, send/broadcast messages, check or wait on an inbox. Use when the user asks to message, notify, hand off to, sync with, or wait for another agent/session/worker, or when working alongside other agents on a shared task.
---

# agentcomm — multi-agent mailbox

A tiny CLI mailbox for passing messages between agents/sessions that share a
storage location (same machine, same mounted volume, or same S3/GCS bucket).
There is no daemon — every command opens the backend, does one operation,
and exits.

## Running the CLI

This plugin ships a prebuilt copy. Invoke it with Node directly:

```bash
node "$CLAUDE_PLUGIN_ROOT/dist/cli.js" <command> [args] [flags]
```

(If the user already has `agentcomm` installed globally or on `PATH`, that
works identically — same commands, same flags.)

## Picking a backend (do this first)

Every agent that should be able to talk to each other must point at the
**same backend**. Decide this before sending anything:

| Situation | Backend | Setup |
| --- | --- | --- |
| Same machine, just trying this out | `file:///tmp/agentcomm` (or any shared dir) | works with **zero dependencies** — default if nothing else is specified |
| Collaborating on a GitHub repo (any mix of laptops, CI, cloud agents) | `github://owner/repo` | **zero setup** when `gh` is logged in or `GITHUB_TOKEN` is set — the repo itself is the bus; messages are commits on an orphan branch, visible on github.com |
| Same machine, multiple processes writing concurrently | `sqlite:///tmp/agentcomm/bus.db` (add `?channel=<name>` to carve isolated channels from one file) | requires `npm install better-sqlite3` in the working project; falls back with a clear error if missing |
| Different machines/containers, need a shared store but not push/claim | `s3://bucket/prefix` or `gs://bucket/prefix` | requires the matching cloud SDK installed |
| Different machines/containers, want atomic claims and instant push | `postgres://user:pass@host:5432/db` (add `?channel=<name>` to carve isolated channels from one database) | requires `npm install pg`; `wait` resolves within ~ms of a `send` instead of polling |

Pass it explicitly on every call with `--backend <uri>`, or export
`AGENTCOMM_BACKEND` once for the session so you don't have to repeat it.
**Tell the user which backend and path you chose** so they (or another
agent) can point at the same one.

Each agent also needs a distinct identity, via `--as <name>` or
`AGENTCOMM_AGENT`. Pick something descriptive (e.g. `planner`, `worker-1`),
not a generic placeholder — other agents will see it as the `from` field.

## Commands

```
register                 Register/heartbeat the calling agent
agents                    List registered agents
send <to> [body]          Send a message (body from arg, or stdin if omitted)
broadcast [body]          Send to every registered agent except yourself
inbox                     Consume undelivered messages (archives them; one-time read)
peek                      Show undelivered messages WITHOUT consuming them
wait                      Block until a message arrives, or until --timeout
claim                     Atomically dequeue one message from --queue (SQL backends only)
log                       Read a channel's whole conversation (pending + archived,
                          time-ordered, NON-consuming, no --as) — --thread, --limit
conventions               The team's rules: lobby, topic naming, subjects
                          (defaults ⊕ .agentcomm.json/.yaml override)
```

Flags: `--backend <uri>`, `--as <name>`, `--subject <text>`, `--thread <id>`,
`--timeout <ms>` (for `wait`, default 30000), `--queue <name>` (for `claim`),
`--json` (machine-readable output on every command).

`wait` exits **0** when a message arrived, **2** on timeout — check the exit
code rather than parsing output when scripting a wait loop. In any scripted
or looping usage, add `--json` and parse that; the human-readable output is
not a stable format.

## Channels — same store, many rooms

A channel **is** a connection string: agents share a bus iff they use the
same `--backend` URI. One store hosts many isolated channels — on
path-carved backends append a segment (`s3://acme-bus/team-a`,
`github://owner/repo/team-a`); on SQL backends append `?channel=<name>`
(`postgres://…/db?channel=team-a`), which keeps claim/push guarantees
isolated per channel.
Don't guess a scheme's rule — ask the CLI, it works with no credentials and
never connects:

```bash
node "$CLAUDE_PLUGIN_ROOT/dist/cli.js" describe --backend s3://acme-bus --json
# → channel rule/template/example + capabilities (claim? push wait?) + caveats
```

Run `describe` before constructing channel URIs on an unfamiliar scheme, and
relay its capability answers instead of trial-and-erroring `claim`/`wait`.
To join existing work, enumerate instead of guessing prefixes:
`channels --backend <store> --json` lists the channels already live on a
store as ready-to-use URIs with agent counts (this one does connect).
Channels are namespacing, not security — isolation is enforced by the
backend's own access controls (IAM, grants, file permissions).

**Joining named work** — when the user says "work on x with the others":

1. `conventions --json` — the project's rules (lobby name, topic naming
   style, subject vocabulary; teams override defaults via `.agentcomm.json`
   or `.agentcomm.yaml`, so never assume — ask the CLI).
2. `channels --backend <store> --json` — see what already exists; the topic
   channel for "x" is `<store>/x` in the conventions' naming style
   (`issue-<n>`/`pr-<n>` for repo-artifact discussions).
3. `register --as <me>` on that channel, then **read the room before
   speaking**: `log --limit 20` shows the whole conversation so far —
   including exchanges between other agents — without consuming anything.
4. Announce yourself (`broadcast --subject status "joining x"`) and work;
   check the `lobby` channel when you need to find who's on what.

## Communication discipline

Sending is the easy half. What makes multi-agent work actually converge:

- **Register before anything else**, and verify your counterpart exists:
  run `agents` and check the name you're about to `send` to is listed. A
  message to a misspelled or never-registered name lands in a mailbox
  nobody reads — no error is raised.
- **Check your inbox at three moments**: when you start a collaborative
  task (there may be instructions already waiting), at natural checkpoints
  between work phases, and **always before reporting your work done** — a
  correction or scope change may have arrived while you worked.
- **Prefer `wait` over sleep-and-poll.** `wait --timeout <ms>` blocks
  efficiently (real push on `postgres://`); a `sleep`/`peek` loop burns
  time and can miss ordering.
- **`wait` does not consume.** It shows the pending messages and exits;
  they stay in the inbox until you run `inbox`. The reliable pattern is
  `wait` (get notified) → `inbox` (consume and act). Don't `wait` again
  without consuming first — it returns instantly with the same messages.
- **Acknowledge and close the loop.** When you receive a task, send a short
  ack on the same thread so the sender knows it was picked up; when you
  finish, send an explicit status: `done`, `blocked: <why>`, or
  `question: <what>`. Silence is indistinguishable from a crashed agent.

## Message conventions

- `--subject` — short intent label (`task`, `ack`, `done`, `question`,
  `status`). The receiver should be able to triage from `peek` output alone.
- `--thread` — correlation id. The task sender picks one (e.g. `auth-42`);
  **every reply about that task carries the same `--thread`**, so both sides
  can match acks/results to requests when several tasks are in flight.
- Body: plain text for humans, or a single JSON object when the receiver is
  scripted — don't mix both in one message.

### When `wait` times out (exit 2)

A timeout is information, not an error: the other agent hasn't replied yet.
Decide explicitly — re-`wait` (bounded: give up after a few rounds, don't
spin forever), proceed without the answer if you safely can, or stop and
report. Whatever you choose, **tell the user the coordination state** ("no
reply from worker-1 after 2×60s, proceeding with defaults") rather than
stalling silently.

### Shared-worker-queue pattern (multiple workers, one queue)

A "queue" is the same namespace as a recipient inbox — `send <queue> ...`
populates it, `claim --queue <queue> --as <owner>` atomically dequeues one
message from it (returns null/no output when empty). Use this instead of
`inbox`/`wait` when several workers should split work from one queue without
double-processing a message. **Only SQL backends (`sqlite://`, `postgres://`)
support `claim`** — on `file://`/`s3://`/`gs://` it errors clearly; don't
fall back to `inbox`/`peek` and call that equivalent, since those don't give
atomic, race-free dequeuing across processes.

On `postgres://`, `wait` is also real push (`LISTEN/NOTIFY`) instead of
polling — same CLI, same exit codes, just faster. No syntax difference; this
happens automatically based on `--backend`.

## Typical flow

A full handoff between two agents, showing the conventions above
(`AC` stands in for `node "$CLAUDE_PLUGIN_ROOT/dist/cli.js"`):

```bash
B="--backend sqlite:///tmp/agentcomm/bus.db"

# each agent registers once
AC register --as planner $B
AC register --as worker  $B

# planner verifies the counterpart is really there, then hands off work
AC agents $B --json                # confirm "worker" appears
AC send worker "build the auth module" --as planner --subject task --thread auth-1 $B

# worker blocks for work (exit 0 = message, exit 2 = timeout), acks on-thread
AC wait --as worker --timeout 60000 $B --json
AC send planner "ack: starting auth module" --as worker --subject ack --thread auth-1 $B

# ... worker does the work ...

# worker drains its inbox BEFORE reporting done (a correction may have arrived),
# then closes the loop on the same thread
AC inbox --as worker $B --json
AC send planner "done: auth module built, tests green" --as worker --subject done --thread auth-1 $B

# planner collects the ack + result, correlated by thread=auth-1
AC inbox --as planner $B --json
```

## Notes

- `inbox` consumes (archives under `read/`, audit trail kept); use `peek` if
  you just want to look without marking messages as delivered.
- On `github://`: poll gently (`wait --timeout 60000`, not tight loops — the
  REST quota is 5,000/hr shared account-wide), one inbox per consumer (no
  `claim`), and tell the user the bus branch URL
  (`https://github.com/<owner>/<repo>/tree/agentcomm`) so they can watch the
  conversation live.
- Housekeeping: when asked to clean the bus, `purge --older-than <dur>`
  trims the `read/` archive on any backend (add `--dry-run` first). On
  `github://` a full reset is deleting the orphan bus branch
  (`gh api -X DELETE repos/<o>/<r>/git/refs/heads/agentcomm`) — it's
  recreated on the next write; confirm with the user before deleting.
- `broadcast` fans out to every name currently in `agents` except the sender
  — make sure relevant agents have `register`ed first.
- Don't put a `sqlite://` backend on a network/object-mounted filesystem
  (e.g. gcsfuse) — its locking guarantees break there. Use `file://`, a real
  local disk for `sqlite://`, or `s3://`/`gs://` directly instead.
- If a backend's optional driver isn't installed (`better-sqlite3` for
  `sqlite://`, the AWS/GCS SDKs for `s3://`/`gs://`, `pg` for `postgres://`),
  the CLI prints exactly which package to `npm install` — relay that to the
  user rather than guessing.
- A third party can add a brand-new `--backend <scheme>://` via
  `registerBackend()` without any agentcomm changes (set
  `AGENTCOMM_BACKEND_PLUGINS` to load it) — mention this if the user asks
  about a backend that isn't file/sqlite/s3/gs/postgres.
