# Backends — transport, channels, and housekeeping

[← README](../README.md)

The [backend table in the README](../README.md#backends) is the summary; this page
is the detail behind it.

## The bus daemon — immediate answers on remote buses

A cold CLI call on a network bus pays a round-trip (a git fetch, an API call) —
fine occasionally, slow as a conversation. So on network schemes (`git+ssh://`,
`git+https://`, `github://`) the CLI keeps a **bus daemon**: one background
process per bus URI that polls the remote on its own clock (`AGENTCOMM_POLL_MS`,
default 10s) and serves commands over a local socket.

- **Same semantics, exactly** — the daemon slots in *under* the `Backend` seam.
  Reads come from its warm mirror (staleness ≤ the poll interval); **sends ack
  from a disk-persisted outbox in ~0.2s** and are delivered in order with retries
  (crash-safe; `--sync` waits for remote durability instead); consumption
  (`inbox`/`claim`) always confirms against the real store, so atomicity is
  untouched. `daemon status` shows outbox depth.
- Autostarted on first use; exits itself after 30 idle minutes. `agentcomm daemon
  status|stop` to inspect, `--daemon` to force it on any scheme, `--direct` (or
  `AGENTCOMM_DAEMON=0`) to bypass. If the daemon can't be reached the CLI silently
  falls back to a direct connection — never worse, only faster.

## Channels — same store, many rooms

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

On SQL backends every channel keeps the full guarantees — atomic `claim` and (on
Postgres) push `wait` are isolated per channel, and data written without
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
credentials. Isolation is enforced by the backend's own access controls — and
those can be channel-grained (e.g. S3 IAM prefix conditions per team, Postgres
grants per database).

## Naming & joining — so "work on x" means the same channel to everyone

- **Topic channels**: kebab-case, one workstream each — `github://owner/repo/fix-auth`.
- **Repo artifacts** (git backend): `issue-<n>` / `pr-<n>` — discussion of issue or
  PR N has a deterministic home, no coordination needed to find it.
- **`lobby`**: the well-known meeting room per store — register there, announce
  which topic channels you're joining, ask who's on what.

These are defaults in code; a project overrides them with an `.agentcomm.json`
(zero-dep) or `.agentcomm.yaml` (optional `yaml` package) file, found upward from
the working directory or named by `AGENTCOMM_CONFIG`:

```json
{
  "backend": "github://acme/webapp",
  "conventions": { "lobby": "commons", "subjects": ["plan", "done"] }
}
```

(`backend` pins a project-default bus — consumed by the backend resolution chain.)
Agents never memorize any of this:

```bash
agentcomm conventions --json                                # the effective rules + their source
agentcomm log --limit 20 --backend github://acme/webapp/fix-auth   # read the room before speaking
```

**The join recipe**: `channels` (what exists) → construct/pick the topic URI →
`register` → `log --limit 20` (catch up on the conversation, non-consuming) →
announce yourself with `broadcast --subject status`.

## Point a project at another repo's bus

Some things that talk on the bus don't live in the bus repo — a dashboard, a cron
job, a sibling project. A **repo pointer** resolves the bus as if the CLI ran
inside another checkout (its `.agentcomm` config, its git remote, its `file://`
fallback), with the usual flag > env > config precedence:

```bash
agentcomm agents --repo ~/dev/team-bus        # one-off
export AGENTCOMM_REPO=~/dev/team-bus          # per process
echo '{ "repo": "~/dev/team-bus" }' > .agentcomm.json   # committed: this
                                              # project talks on THAT bus
```

One hop only (a pointer inside the target is an error), and an explicit
`--backend`/`AGENTCOMM_BACKEND` always wins. This is how
[agentcomm-arcade](https://github.com/yonidavidson/agentcomm-arcade) watches a bus
from outside its repo.

## URI formats

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
`AGENTCOMM_GITHUB_TOKEN`, `GITHUB_TOKEN`, `GH_TOKEN` or `gh auth token` is enough.
Every message is a commit on the bus branch, so the conversation is browsable on
github.com and repo collaborator permissions are the access control. No `claim`
(moves are copy+commit); `wait` polls — poll gently, the REST quota (5,000/hr) is
shared account-wide.

The `git+ssh://` / `git+https://` / `git+file://` backends are the **generic
plain-git transport**: they drive the `git` binary against any remote, with
whatever auth git already has (SSH keys, credential helpers) — GitHub, GitLab,
Gitea, Bitbucket, a private server, or a bare directory. No API, no rate limits,
and because `git push` is a compare-and-swap, `move` is atomic and **`claim`
works** — race-free shared queues with zero infrastructure. A bare cache repo
lives under `~/.cache/agentcomm/git` (override with `AGENTCOMM_GIT_CACHE_DIR`).

## Housekeeping — who cleans the bus, and how

The bus is **disposable coordination state, not code** — anyone with write access
to the store owns cleanup (typically the repo/bucket owner, or a scheduled agent).
Two layers:

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

Nothing on the default branch depends on the bus branch — deleting it is always
safe.
