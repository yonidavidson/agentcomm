# How it works — key layout & intentional constraints

[← README](../README.md)

The bus is just a key layout on top of the blob `Backend`:

```
agents/<name>.json                  registry + heartbeat
inbox/<recipient>/<seq>_<id>.json   undelivered messages
read/<recipient>/<seq>_<id>.json    archived after consumption (audit trail)
events/…                            the append-only telemetry lane (opt-in)
```

`<seq>` is a zero-padded, monotonic, lexicographically-sortable prefix, so a
`list()` returns messages in **send order**. Consuming a message `move()`s it from
`inbox/` to `read/` — messages are archived, never hard-deleted. A **queue** (for
`claim`) is the same namespace as a recipient inbox — `send` populates it, `claim`
atomically dequeues from it instead of a single consumer reading via `inbox`.

The `Backend` interface is the whole seam: `put · get · list · delete · exists ·
move`. Everything else — conventions, channels, telemetry, presence — is built on
top of those six calls, which is why a new transport is a ~200-line class and
never a CLI redesign.

## Design notes (intentional constraints)

- **Single-consumer-per-inbox is a feature.** It's what makes the object-store
  backends race-free without locks. `claim` exists only where the store gives a
  real atomic primitive — SQL transactions, or `git push` as a compare-and-swap;
  `file://`/`s3://`/`gs://` error clearly rather than faking it with locks.
- **Names are aliases, not authentication.** `--as` is addressing. On git backends
  the commit author in `git log` is the verifiable identity.
- **Don't put SQLite on object storage.** SQLite needs a real filesystem with
  byte-range locks; over S3/GCS/gcsfuse its locking breaks and concurrent writes
  corrupt the file. `sqlite://` is for local/persistent disk only.
- **`wait`'s contract is identical on every backend** (exit 0 delivered / 2
  timeout), whether it polls (Local/SQLite/object stores) or pushes (Postgres, via
  `LISTEN/NOTIFY`).
- **New drivers are optional + lazy.** A missing driver produces a clear
  `install X` message, not a crash — so `LocalBackend` stays zero-dependency.
- **PostgresBackend uses one schema for everything.** Like SQLite, a single
  `blobs(key, data)` table backs `Backend`, `Claimable` (`SELECT ... FOR UPDATE
  SKIP LOCKED`), and `Waitable` (`put()` issues `pg_notify()` when the key is under
  `inbox/<recipient>/`) — no separate `messages` table with `owner`/`claimed_at`
  columns. Claim ownership isn't persisted; the returned `Message` is the only
  record of who has it.
