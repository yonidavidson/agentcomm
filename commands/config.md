---
description: Explain and edit this repo's .agentcomm config — backend, conventions, telemetry — without a trip to the README
argument-hint: (no args, or a question like "track my review skill")
allowed-tools: Bash(agentcomm conventions:*) Bash(node:*)
---

The repo's current effective agentcomm configuration:

!`agentcomm conventions --json 2>/dev/null || node "${CLAUDE_PLUGIN_ROOT}/dist/cli.js" conventions --json 2>/dev/null || echo "(agentcomm CLI not reachable)"`

You are helping the user understand and edit their agentcomm config. The
output above shows what is in effect right now — `source: null` means
built-in defaults with no config file yet. Answer their question ($ARGUMENTS
if given), and when they want a change, write or edit the file for them.

## The config file

`.agentcomm.json` (zero-dep) or `.agentcomm.yaml`/`.yml` (needs the optional
`yaml` package), searched from the working directory upward; `AGENTCOMM_CONFIG`
names a file explicitly. It is versioned with the repo — reviewable and shared
like code. Full surface:

```yaml
# Pin the bus every agent in this repo uses (otherwise: AGENTCOMM_BACKEND >
# this file > git-remote autodetect > file://./.agentcomm)
backend: git+ssh://git@github.com/acme/webapp.git

# The social contract — how agents name rooms and label mail
conventions:
  lobby: lobby                      # well-known meeting-room channel
  topicStyle: kebab-case            # "work on x" → channel name style
  artifactChannels:
    issue: issue-<n>                # channel bound to issue N
    pr: pr-<n>                      # channel bound to PR N
  subjects: [task, ack, done, revision, question, status]

# Telemetry (opt-in BY PRESENCE of this section — without it, emit and the
# capture hooks are inert). Deterministic: if a rule is listed, it fires.
telemetry:
  track:
    - on: skill                     # skill | merge | session | task
      match: code-review            # optional name filter; * globs work
      record: >                     # optional FREE TEXT — injected at session
        whether it uncovered bugs,  # start so the agent self-reports this
        findings count, iteration   # outcome via `agentcomm emit`
    - on: merge
    - on: session
  # retention: 180d                 # default keeps everything; purge --events
  #                                 # or this horizon are the only aging paths
```

Notes worth relaying when relevant:

- **conventions** merge per-section over the defaults shown above — set only
  what differs.
- **telemetry** semantics: `on`/`match` drive the deterministic hooks (skill
  runs, `git merge`/`gh pr merge`, session start/end, task events);
  `record:` free text becomes session-start instructions for the model's
  self-reports (`agentcomm emit --type <on>-outcome --attrs '{...}'`).
  Events accumulate under `events/` on the bus; `agentcomm events --json`
  reads them back. Registrations are never purged — events reference them.
- **Env knobs** (runtime, not the file): `AGENTCOMM_BACKEND` (override bus),
  `AGENTCOMM_AGENT` (alias), `AGENTCOMM_DAEMON=0` (bypass daemon),
  `AGENTCOMM_SYNC=1` (durable sends), `AGENTCOMM_POLL_MS` (daemon poll),
  `AGENTCOMM_PURGE_AFTER_MS` (daemon archive TTL, 30d).
- After editing, `agentcomm conventions` (no `--json`) is the quick check
  that the file parses and shows what took effect. JSON needs nothing;
  YAML needs `npm install yaml`.

When the user asks for something the config cannot express (e.g. per-agent
permissions, message encryption), say so plainly instead of inventing keys —
unknown keys are ignored, not errors.
