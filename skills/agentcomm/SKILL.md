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
**same backend**. In a git repo the default already IS the repo bus: with no
`--backend`, agentcomm probes `origin` and picks `git+<origin>` (any host,
atomic claim) or `github://` when only a token exists — it says so on stderr.
Otherwise, decide before sending anything:

| Situation | Backend | Setup |
| --- | --- | --- |
| Same machine, just trying this out | `file:///tmp/agentcomm` (or any shared dir) | works with **zero dependencies** — default if nothing else is specified |
| Collaborating on ANY git repo (GitHub, GitLab, Gitea, private; laptops, CI, cloud) | `git+ssh://git@host/owner/repo.git` (also `git+https://`, `git+file://`; `?channel=<name>` carves channels) | needs only the `git` binary + git's existing auth (SSH keys/credential helper); no rate limits; `claim` works (push is a compare-and-swap) |
| GitHub when only a token exists (CI runners, no ssh) | `github://owner/repo` | **zero setup** when `gh` is logged in or `GITHUB_TOKEN` is set — the repo itself is the bus; messages are commits on an orphan branch, visible on github.com |
| Same machine, multiple processes writing concurrently | `sqlite:///tmp/agentcomm/bus.db` (add `?channel=<name>` to carve isolated channels from one file) | requires `npm install better-sqlite3` in the working project; falls back with a clear error if missing |
| Different machines/containers, need a shared store but not push/claim | `s3://bucket/prefix` or `gs://bucket/prefix` | requires the matching cloud SDK installed |
| Different machines/containers, want atomic claims and instant push | `postgres://user:pass@host:5432/db` (add `?channel=<name>` to carve isolated channels from one database) | requires `npm install pg`; `wait` resolves within ~ms of a `send` instead of polling |

Pass it explicitly on every call with `--backend <uri>`, or export
`AGENTCOMM_BACKEND` once for the session so you don't have to repeat it.
**Tell the user which backend and path you chose** so they (or another
agent) can point at the same one.

Each agent acts under an alias, via `--as <name>` or `AGENTCOMM_AGENT` —
omitted, it defaults to the git identity (user.email local-part), then the
OS username, announced on stderr. The default is `<git-identity>-<session-id>` — a
mailbox unique to this session, so concurrent runners on one machine never
consume each other's mail. Use it freely for ad-hoc work; when others must
address you by name (reviewer, worker-1), register that role with `--as`
and keep it stable. Never share an alias between live processes — inbox
reads consume. `register` WARNS when the alias was recently active from a
different session (registrations carry a session fingerprint, and `agents`
marks entries from "(this session)") — on that warning, pick a distinct
alias unless you are certain the other process is gone.
**Aliases are addressing, not authentication** — anyone with write access
can use any name; on git backends the commit author in `git log` is the
verifiable identity, so tell the user to check history if provenance matters.

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

## The bus daemon (speed on remote buses)

On network buses (`git+ssh://`, `github://`) the CLI automatically keeps a
per-bus background daemon that polls the remote (default 10s,
`AGENTCOMM_POLL_MS`) and answers locally — commands are immediate, `wait`
loops cost nothing between remote polls, and semantics are IDENTICAL
(`claim`/`inbox` stay atomic on the real store). Sends ack in ~0.2s from
the daemon's crash-safe disk outbox and are delivered in order behind the
scenes — exit 0 means "accepted durably", remote visibility follows within
seconds; pass `--sync` when a caller must wait for remote durability.
Nothing to manage: it autostarts, idles out after 30min, and any failure
falls back to a direct connection. `agentcomm daemon status|stop` to
inspect; `--daemon` forces it on any scheme, `--direct` bypasses. Only
caveat: reads can lag a foreign write by up to one poll interval — that is
the deal the daemon makes.

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

## What the plugin's hooks already do for you (Claude Code)

In repos that ran `agentcomm init` (the `<!-- agentcomm -->` marker in
CLAUDE.md is the consent gate), this plugin ships hooks that make part of
the discipline mechanical — don't duplicate them:

- **Session start**: the hook REGISTERS you (throttled heartbeat) and hands
  you a context note — bus URI, your alias, mail already waiting, the live
  roster. No need to probe or register again — if the note isn't there,
  the repo isn't on a bus.
- **Stopping**: a guard peeks (non-consuming) at your derived mailbox and
  blocks finishing once if unread messages exist — handle them via
  `agentcomm inbox --json` (or tell the user why not), then finish.
- **During the session**: a throttled digest (≤ once per 5min, only when
  there is news) may appear in your context — unread count, riders that
  joined, and what active agents say they're doing. Act on it like any bus
  fact; no need to re-check what it reports.

**Write your own status** when you start or finish a named piece of work:
`agentcomm register --status "reviewing PR 12"` (short, present tense; it
persists across heartbeats until you change it — clear it with
`--status done` when finishing). Other agents and humans see it on the
roster and in digests; it is how "what is everyone doing?" gets answered
without anyone asking.

Still yours: everything about ROLE aliases (`--as` mailboxes
are not guarded — check them yourself), acks/threads, and all sends.

## Delegating the bus to a subagent (keep the main flow clean)

If your harness supports subagents (e.g. Claude Code's Agent tool), prefer
running the LISTENING side of the bus in a background subagent: blocking
`wait` loops and inbox draining are chatty and long-running; a listener
subagent turns them into one summarized report back to the main flow.

- **One actor per mailbox — the hard rule.** A subagent you spawn shares
  your session fingerprint, so bare commands derive YOUR alias: two
  consumers, one mailbox, silently stolen mail (the collision warning only
  fires across sessions). Either delegate the mailbox fully (the listener
  owns the alias; you send but never run `inbox`/`wait`/`claim`), or give
  the listener its own role (`--as <you>-bus`) and have it forward.
- Quick `send`s and acks stay inline — spawning an agent costs more than
  the command.
- Subagents communicate over the bus exactly like any process; their final
  report is the non-intrusive channel back to you.

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
(`AC` stands in for `node "$CLAUDE_PLUGIN_ROOT/dist/cli.js"`). In a shared
git repo NO backend flags are needed — everyone lands on the repo bus; add
`--backend <uri>` only for other stores. planner and worker-1 are ROLES
(addressable by name), so each keeps a stable `--as`:

```bash
# each role registers once (a warning here means the alias is live elsewhere)
AC register --as planner
AC register --as worker-1

# planner verifies the counterpart is really there, then hands off work
AC agents --json                        # confirm "worker-1" appears
AC send worker-1 "build the auth module" --as planner --subject task --thread auth-1

# worker-1 blocks for work (exit 0 = message, exit 2 = timeout), acks on-thread
AC wait --as worker-1 --timeout 60000 --json
AC send planner "ack: starting auth module" --as worker-1 --subject ack --thread auth-1

# ... worker-1 does the work ...

# worker-1 drains its inbox BEFORE reporting done (a correction may have
# arrived), then closes the loop on the same thread
AC inbox --as worker-1 --json
AC send planner "done: auth module built, tests green" --as worker-1 --subject done --thread auth-1

# planner collects the ack + result, correlated by thread=auth-1
AC inbox --as planner --json
```

Working solo (no named role)? Drop every `--as` — bare commands share your
session alias automatically.

## Notes

- `inbox` consumes (archives under `read/`, audit trail kept); use `peek` if
  you just want to look without marking messages as delivered.
- On `github://`: poll gently (`wait --timeout 60000`, not tight loops — the
  REST quota is 5,000/hr shared account-wide), one inbox per consumer (no
  `claim`), and tell the user the bus branch URL
  (`https://github.com/<owner>/<repo>/tree/agentcomm`) so they can watch the
  conversation live.
- If the user asks to set up agentcomm for their repo/team, run
  `agentcomm init --as <user>` — it writes the coordination instructions
  into CLAUDE.md (idempotent), registers them, and shows the roster; remind
  them to commit CLAUDE.md so every teammate's agent joins.
- Housekeeping: mostly automatic — the bus daemon periodically trims the
  archive (30d) and stale registrations (7d). Manual: `purge --older-than
  <dur>` (archive) and/or `purge --agents-older-than <dur>` (idle
  registrations; pending mail never touched); add `--dry-run` first. On
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
