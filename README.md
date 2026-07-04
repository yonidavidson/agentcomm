# agentcomm

🌐 **[Website](https://yonidavidson.github.io/agentcomm/)** · [Use cases](https://yonidavidson.github.io/agentcomm/#use-cases) · [Live demo — an agent conversation that *is* a git branch](https://github.com/yonidavidson/agentcomm/tree/agentcomm) · [Claude Code plugin](#as-a-claude-code-plugin)

A tiny mailbox / message bus for AI agents that shell out to one CLI. Agents
`register`, `send`, and read their `inbox`; a single `Backend` interface hides
where the messages actually live. Local runs need **zero dependencies**; other
backends are **optional, lazy-loaded** drivers — and `github://` needs no
driver at all.

```
            ┌─────────────────────────────────────────────┐
 agents ──▶ │  agentcomm CLI  (one stable interface)        │
            │      │                                         │
            │      ▼                                         │
            │  Backend interface  ◀── the seam               │
            │   ├─ LocalBackend    — zero-dep default         │
            │   ├─ GithubBackend   — the repo is the bus      │
            │   ├─ SqliteBackend   — single box (recommended) │
            │   ├─ S3Backend       — object store             │
            │   ├─ GCSBackend      — object store             │
            │   └─ PostgresBackend — distributed, push        │
            └─────────────────────────────────────────────┘
```

## Install

Not on the npm registry (yet) — install straight from GitHub. `dist/` is
committed to the repo, so this needs no build step:

```bash
npm install github:yonidavidson/agentcomm

# optional drivers, installed only if you use that backend:
npm install better-sqlite3            # sqlite://
npm install @aws-sdk/client-s3        # s3://
npm install @google-cloud/storage     # gs://
npm install pg                        # postgres://
```

The local filesystem backend needs nothing beyond Node ≥ 18.

### As a Claude Code plugin

This repo is also a self-hosted Claude Code plugin marketplace — install it
and Claude picks up a skill that knows the CLI's commands, flags, and
backend tradeoffs, and uses them to coordinate with other agents/sessions:

```
/plugin marketplace add yonidavidson/agentcomm
/plugin install agentcomm@yonidavidson-plugins
```

No global install or npm registry publish required — the plugin ships a
prebuilt copy of the CLI (`dist/cli.js`) and the skill runs it with
`node "$CLAUDE_PLUGIN_ROOT/dist/cli.js" ...`, defaulting to the zero-dependency
`file://` backend.

## Quick start

```bash
# pick a backend once via env (or pass --backend each call)
export AGENTCOMM_BACKEND=sqlite:///tmp/bus.db

agentcomm register --as alice
agentcomm register --as bob

agentcomm send bob "ship it" --as alice --subject plan
agentcomm inbox --as bob --json        # consumes; archives under read/
agentcomm peek  --as bob               # non-consuming
agentcomm wait  --as bob --timeout 30000   # exit 0 on delivery, 2 on timeout

# shared-worker-queue pattern (multiple workers, one queue) — SQL backends only
agentcomm send work-queue "task-1" --as producer
agentcomm claim --queue work-queue --as worker-1   # atomic; null when empty

# distributed (across machines/containers) — real push, not poll
export AGENTCOMM_BACKEND=postgres://user:pass@host:5432/agentcomm
agentcomm wait --as bob --timeout 30000   # resolves within ~ms of a send, via LISTEN/NOTIFY
```

`send`/`broadcast` read the body from the trailing argument, or from **stdin**
if omitted:

```bash
echo "from a pipe" | agentcomm send bob --as alice
```

## What people build with it

- **Agents sharing a GitHub repo, talking through it** — `github://owner/repo`
  makes the repo the bus: repo permissions are the ACL, every message is a
  commit you can watch in the web UI.
- **Cloud + local worker fleets** splitting one queue with atomic `claim`.
- **A CD pipeline you can ask** "what's the status of the build?" mid-deploy.
- **IoT edge agents** — a camera answering "what do you see?", weather sensors
  reporting humidity to one `broadcast` — on nothing but outbound HTTPS.
- **Two AI tools pairing on one machine** (Claude Code implements, Cursor
  reviews) over a SQLite file.

All illustrated with runnable commands on the
[use-cases page](https://yonidavidson.github.io/agentcomm/#use-cases) — plus
why the security story is *subtraction*: your storage's auth is the bus's auth.

## Commands

| Command            | What it does                                                        |
| ------------------ | ------------------------------------------------------------------- |
| `register`         | Register / heartbeat the calling agent (`--as`).                    |
| `agents`           | List registered agents.                                             |
| `send <to> [body]` | Send a message (body from arg or stdin).                            |
| `broadcast [body]` | Send to every registered agent except yourself.                    |
| `inbox`            | **Consume** undelivered messages; archives them under `read/`.      |
| `peek`             | Show undelivered messages **without** consuming.                    |
| `wait`             | Block until a message arrives (**exit 0**) or timeout (**exit 2**). |
| `claim`            | Atomically dequeue one message from `--queue` (**SQL backends only**). |
| `describe`         | Explain the `--backend` scheme: how channels are carved from the URI, and its capabilities. **Static** — never loads a driver or connects. |
| `channels`         | List the channels that already exist on the `--backend` store (scans for the agentcomm key layout; needs the driver + credentials). |
| `purge`            | Delete archived (`read/`) messages older than `--older-than` (`30d`, `12h`, …). Never touches pending mail or registrations. |

### Flags

| Flag               | Meaning                                                        |
| ------------------ | -------------------------------------------------------------- |
| `--backend <uri>`  | Backend URI (env `AGENTCOMM_BACKEND`; default `file://./.agentcomm`). |
| `--as <name>`      | Acting agent (env `AGENTCOMM_AGENT`).                          |
| `--subject <text>` | Message subject (`send`/`broadcast`).                          |
| `--thread <id>`    | Thread id (`send`/`broadcast`).                                |
| `--timeout <ms>`   | `wait` timeout in ms (default `30000`).                        |
| `--queue <name>`   | Queue to claim from (`claim`) — same namespace as a recipient inbox. |
| `--older-than <dur>` | Age threshold for `purge` (`45s`, `30m`, `12h`, `30d`).      |
| `--dry-run`        | `purge` only lists what it would delete.                       |
| `--json`           | Machine-readable JSON output (available on every command).     |

## Backends

Choose transport by **topology** — that's the only fork that matters.

| Backend     | URI                          | Driver (optional)      | Atomic `move` | `claim` (shared queue) | Push (`wait`) | Use when                         |
| ----------- | ---------------------------- | ---------------------- | :-----------: | :--------------------: | :-----------: | -------------------------------- |
| **Local**   | `file:///path/dir`, bare dir | — (built in)           | ✅ (rename)   | ❌                     | poll          | dev, single process, zero deps   |
| **GitHub**  | `github://owner/repo[/prefix]` | — (built in)         | ❌ (copy+commit) | ❌                  | poll          | **agents sharing a repo** — the repo is the bus |
| **SQLite**  | `sqlite:///path.db[?channel=x]`, `*.db` | `better-sqlite3` | ✅ (txn)   | ✅ (txn)              | poll          | **single machine** (recommended) |
| **S3**      | `s3://bucket/prefix`         | `@aws-sdk/client-s3`   | ❌ (copy+del) | ❌                     | poll          | shared object store              |
| **GCS**     | `gs://bucket/prefix`         | `@google-cloud/storage`| ❌ (copy+del) | ❌                     | poll          | shared object store              |
| **Postgres**| `postgres://…/db[?channel=x]` | `pg`                | ✅ (txn)      | ✅ `SKIP LOCKED`       | ✅ **push**   | **across machines/containers**   |

**Rule of thumb:**

- **One machine → `sqlite://`.** WAL mode gives you ACID, atomic per-key writes
  and an atomic `move`, with no daemon. This is the recommended default.
- **Across machines/containers → `postgres://`** for race-free shared queues
  (`SKIP LOCKED`) and real push (`LISTEN/NOTIFY`) in one boring dependency.

### Channels — same store, many rooms

A **channel is a connection string**: two agents share a bus iff they pass the
same `--backend` URI. One store can host many isolated channels — for the
path-carved backends, just append a segment:

```
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
```

The `github://` backend needs **no npm driver at all** — a token from
`AGENTCOMM_GITHUB_TOKEN`, `GITHUB_TOKEN`, `GH_TOKEN` or `gh auth token` is
enough. Every message is a commit on the bus branch, so the conversation is
browsable on github.com and repo collaborator permissions are the access
control. No `claim` (moves are copy+commit); `wait` polls — poll gently, the
REST quota (5,000/hr) is shared account-wide.

### Housekeeping — who cleans the bus, and how

The bus is **disposable coordination state, not code** — anyone with write
access to the store owns cleanup (typically the repo/bucket owner, or a
scheduled agent). Two layers:

```bash
# every backend: trim the archive (read/); pending mail + registrations are never touched
agentcomm purge --older-than 30d --backend <uri>          # add --dry-run to preview

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
  backends race-free without locks. Only SQL backends implement `Claimable`
  for the shared-queue `claim` path; `LocalBackend`/`S3Backend`/`GCSBackend`
  don't, and `claim` errors clearly rather than faking it with locks.
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
npm install                 # dev toolchain (cloud SDKs are optional)
npm install better-sqlite3  # to run the SQLite tests locally
npm install pg              # to run the Postgres tests locally
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
all six backends are exercised end-to-end.

The test suite runs the **same backend-contract and bus tests** against
`LocalBackend`, `SqliteBackend`, `S3Backend`, `GCSBackend`, `GithubBackend`,
and `PostgresBackend`, plus concurrency tests
proving: WAL lets independent SQLite writers proceed; N concurrent processes
calling `claim` on one shared queue (SQLite or Postgres) get disjoint
messages, none dropped, none double-delivered; and `wait` on Postgres
resolves within tens of ms of a `send` from a **separate OS process** (real
push via `LISTEN/NOTIFY`, not a poll interval). CLI end-to-end tests cover the
`wait` exit codes, the `claim` error/empty/success paths, the
`AGENTCOMM_BACKEND_PLUGINS` loading mechanism, and the missing-driver error
path.

## Roadmap

The transport stack is complete: six backends, capability interfaces
(`Claimable`/`Waitable`, feature-detected), channels, self-describing schemes,
and the `registerBackend()` plugin seam. What's next lives in the
[issue tracker](https://github.com/yonidavidson/agentcomm/issues) — currently:
a `gitlab://` sibling backend and a host-agnostic `git://` (any git remote)
backend (#23).

## License

MIT © Yoni Davidson
