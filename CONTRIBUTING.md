# Contributing

```bash
npm install                 # dev toolchain incl. all backend drivers (devDependencies)
npm run typecheck
npm test                    # vitest: backend contract, bus, CLI e2e, WAL/Postgres concurrency
npm run build               # emit dist/
```

## Tests that need live services

The S3, GCS and Postgres suites (`test/s3.test.ts`, `test/gcs.test.ts`,
`test/postgres.test.ts`) need live services — each skips itself with a console
warning when its service is unreachable. One command brings everything up
([Garage](https://garagehq.deuxfleurs.fr/), an S3-compatible object store written
in Rust; fake-gcs-server; and Postgres — buckets and keys provisioned by
`test/e2e/setup.sh` with fixed throwaway credentials):

```bash
npm run test:e2e:up    # docker compose up + provision buckets/keys
npm test               # now runs ALL suites, nothing skipped
npm run test:e2e:down  # tear down (removes volumes)
# point at other services with AGENTCOMM_TEST_S3_ENDPOINT,
# AGENTCOMM_TEST_GCS_ENDPOINT or AGENTCOMM_TEST_POSTGRES_URL
```

The `github://` suite (`test/github.test.ts`) targets a real repo on a scratch
branch, deleted afterwards — gate it with
`AGENTCOMM_TEST_GITHUB_REPO=you/yourrepo` (your `gh` login is enough). In CI it
runs against **this repository itself** using the workflow's token.

CI (`.github/workflows/ci.yml`) runs this same flow on every push and PR, so all
seven backends are exercised end-to-end.

### What the suite proves

The same backend-contract and bus tests run against every backend (the git suite
runs against local bare repos, so its full fetch/plumbing/push path needs no
services), plus concurrency tests proving: WAL lets independent SQLite writers
proceed; N concurrent processes calling `claim` on one shared queue (SQLite or
Postgres) get disjoint messages, none dropped, none double-delivered; and `wait`
on Postgres resolves within tens of ms of a `send` from a **separate OS process**
(real push via `LISTEN/NOTIFY`, not a poll interval). CLI end-to-end tests cover
the `wait` exit codes, the `claim` error/empty/success paths, the
`AGENTCOMM_BACKEND_PLUGINS` loading mechanism, and the missing-driver error path.

## Releasing

Two moves. First the version bump lands as a normal PR (main is protected, so this
rides the required CI check like any change): `npm version X.Y.Z
--no-git-tag-version`, committed. Then one dispatch releases the tree `main`
carries:

```bash
gh workflow run release-cut.yml -f version=current   # or X.Y.Z as a guard
```

The workflow is commit-free on main: it verifies the version guard, sanity-tests,
tags, publishes the GitHub Release with generated notes, and hands off to
`release.yml`, which publishes to the **npm registry** (trusted publishing / OIDC,
with provenance — no token secret). That is the only channel: releases carried
`npm pack` tarballs as a registry-less fallback until 0.21.0, and issue #155 has
the download numbers that ended them. No docs follow-up — everything points at
`@yonidavidson/agentcomm@latest`, which never needs a version bump.
