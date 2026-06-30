# agentcomm

A tiny mailbox / message bus for AI agents that shell out to one CLI. Agents
`register`, `send`, and read their `inbox`; a single `Backend` interface hides
where the messages actually live. Local runs need **zero dependencies**; cloud
and SQL backends are **optional, lazy-loaded** drivers.

```
            ┌─────────────────────────────────────────────┐
 agents ──▶ │  agentcomm CLI  (one stable interface)        │
            │      │                                         │
            │      ▼                                         │
            │  Backend interface  ◀── the seam               │
            │   ├─ LocalBackend   — zero-dep default          │
            │   ├─ SqliteBackend  — single box (recommended)  │  TRANSPORT
            │   ├─ S3Backend      — object store               │  (live, hot path)
            │   ├─ GCSBackend     — object store               │
            │   └─ PostgresBackend — distributed, push         │
            └─────────────────────────────────────────────┘
```

> **Status:** Transport core, `SqliteBackend` (single-box default),
> `PostgresBackend` (distributed, atomic `claim`, real `LISTEN/NOTIFY` push),
> and the `registerBackend()` plugin seam are implemented and tested. The
> offline DuckDB/Parquet analytics export is planned — see
> [Roadmap](#roadmap).

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

### Flags

| Flag               | Meaning                                                        |
| ------------------ | -------------------------------------------------------------- |
| `--backend <uri>`  | Backend URI (env `AGENTCOMM_BACKEND`; default `file://./.agentcomm`). |
| `--as <name>`      | Acting agent (env `AGENTCOMM_AGENT`).                          |
| `--subject <text>` | Message subject (`send`/`broadcast`).                          |
| `--thread <id>`    | Thread id (`send`/`broadcast`).                                |
| `--timeout <ms>`   | `wait` timeout in ms (default `30000`).                        |
| `--queue <name>`   | Queue to claim from (`claim`) — same namespace as a recipient inbox. |
| `--json`           | Machine-readable JSON output (available on every command).     |

## Backends

Choose transport by **topology** — that's the only fork that matters.

| Backend     | URI                          | Driver (optional)      | Atomic `move` | `claim` (shared queue) | Push (`wait`) | Use when                         |
| ----------- | ---------------------------- | ---------------------- | :-----------: | :--------------------: | :-----------: | -------------------------------- |
| **Local**   | `file:///path/dir`, bare dir | — (built in)           | ✅ (rename)   | ❌                     | poll          | dev, single process, zero deps   |
| **SQLite**  | `sqlite:///path.db`, `*.db`  | `better-sqlite3`       | ✅ (txn)      | ✅ (txn)              | poll          | **single machine** (recommended) |
| **S3**      | `s3://bucket/prefix`         | `@aws-sdk/client-s3`   | ❌ (copy+del) | ❌                     | poll          | shared object store              |
| **GCS**     | `gs://bucket/prefix`         | `@google-cloud/storage`| ❌ (copy+del) | ❌                     | poll          | shared object store              |
| **Postgres**| `postgres://…` / `postgresql://…` | `pg`             | ✅ (txn)      | ✅ `SKIP LOCKED`       | ✅ **push**   | **across machines/containers**   |

**Rule of thumb:**

- **One machine → `sqlite://`.** WAL mode gives you ACID, atomic per-key writes
  and an atomic `move`, with no daemon. This is the recommended default.
- **Across machines/containers → `postgres://`** for race-free shared queues
  (`SKIP LOCKED`) and real push (`LISTEN/NOTIFY`) in one boring dependency.

### URI formats

```
file:///abs/path/dir          filesystem (absolute)
file://relative/dir           filesystem (relative to cwd)
/abs/path  or  ./rel          bare path → filesystem
sqlite:///abs/path/to.db      single-file SQLite (WAL)
./bus.db                      bare path ending in .db → SQLite
s3://bucket/optional/prefix   S3
gs://bucket/optional/prefix   GCS
postgres://user:pass@host/db  Postgres (postgresql:// also accepted)
```

### Writing a backend plugin

`createBackend` doesn't special-case the four built-ins — they're registered
through the exact same seam any third-party package uses:

```ts
import { registerBackend } from 'agentcomm';
import type { Backend } from 'agentcomm';

class RedisBackend implements Backend { /* put/get/list/delete/exists/move */ }

registerBackend('redis', async (uri) => new RedisBackend(uri));
```

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

The Postgres tests (`test/postgres.test.ts`) need a real database — they
skip themselves with a console warning if none is reachable. Spin one up
with Docker:

```bash
docker run -d --name agentcomm-pg-test -e POSTGRES_PASSWORD=test \
  -e POSTGRES_DB=agentcomm -p 55432:5432 postgres:16-alpine
# defaults to postgresql://postgres:test@localhost:55432/agentcomm;
# override with AGENTCOMM_TEST_POSTGRES_URL
```

The test suite runs the **same backend-contract and bus tests** against
`LocalBackend`, `SqliteBackend`, and `PostgresBackend`, plus concurrency tests
proving: WAL lets independent SQLite writers proceed; N concurrent processes
calling `claim` on one shared queue (SQLite or Postgres) get disjoint
messages, none dropped, none double-delivered; and `wait` on Postgres
resolves within tens of ms of a `send` from a **separate OS process** (real
push via `LISTEN/NOTIFY`, not a poll interval). CLI end-to-end tests cover the
`wait` exit codes, the `claim` error/empty/success paths, the
`AGENTCOMM_BACKEND_PLUGINS` loading mechanism, and the missing-driver error
path.

## Roadmap

Tracked against the original build plan:

1. ✅ **`SqliteBackend`** — drop-in single-box transport (WAL). *Done.*
2. ✅ **Capability interfaces** — `Claimable` (atomic shared-queue `claim`)
   and `Waitable` (push). The Bus feature-detects both and falls back to
   list+move / polling when absent. *Done.*
3. ✅ **`PostgresBackend`** — distributed transport: `claim` via
   `SELECT … FOR UPDATE SKIP LOCKED`, push via `LISTEN/NOTIFY`. *Done.*
4. ⏳ **Analytics export** — offline `archive export` to Parquet on S3/GCS, with
   a DuckDB/DuckLake query recipe. Never on the hot path. *Planned.*

Also shipped, beyond the original brief: a **backend plugin registry**
(`registerBackend()`) so third parties can add a new `--backend <scheme>://`
without any agentcomm changes — see "Writing a backend plugin" above.

## License

MIT © Yoni Davidson
