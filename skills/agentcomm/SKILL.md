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
| Same machine, multiple processes writing concurrently | `sqlite:///tmp/agentcomm/bus.db` | requires `npm install better-sqlite3` in the working project; falls back with a clear error if missing |
| Different machines/containers, need a shared store but not push/claim | `s3://bucket/prefix` or `gs://bucket/prefix` | requires the matching cloud SDK installed |
| Different machines/containers, want atomic claims and instant push | `postgres://user:pass@host:5432/db` | requires `npm install pg`; `wait` resolves within ~ms of a `send` instead of polling |

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
```

Flags: `--backend <uri>`, `--as <name>`, `--subject <text>`, `--thread <id>`,
`--timeout <ms>` (for `wait`, default 30000), `--queue <name>` (for `claim`),
`--json` (machine-readable output on every command).

`wait` exits **0** when a message arrived, **2** on timeout — check the exit
code rather than parsing output when scripting a wait loop.

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

```bash
B="--backend sqlite:///tmp/agentcomm/bus.db"

# each agent registers once
node "$CLAUDE_PLUGIN_ROOT/dist/cli.js" register --as planner $B
node "$CLAUDE_PLUGIN_ROOT/dist/cli.js" register --as worker  $B

# planner hands off work
node "$CLAUDE_PLUGIN_ROOT/dist/cli.js" send worker "build the auth module" --as planner --subject task $B

# worker checks for work, blocking up to 60s
node "$CLAUDE_PLUGIN_ROOT/dist/cli.js" wait --as worker --timeout 60000 $B --json

# worker reports back
node "$CLAUDE_PLUGIN_ROOT/dist/cli.js" send planner "done" --as worker --thread task-1 $B
```

## Notes

- `inbox` consumes (archives under `read/`, audit trail kept); use `peek` if
  you just want to look without marking messages as delivered.
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
