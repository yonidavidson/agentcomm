# Telemetry events — the append-only lane

[← README](../README.md)

Beside the mailbox lane there is an **event lane**
([design](https://github.com/yonidavidson/agentcomm/issues/100)): append-only facts
under `events/` — "skill X ran", "branch Y merged", "the review found 3 bugs" —
that later answer questions like *"how many runs of `/my-review-skill` uncovered
bugs, and how many iterations before merge?"*.

It is **opt-in per repo and deterministic**: telemetry exists only when the
`.agentcomm.json`/`.yaml` config declares it, and then it always fires — no
discretion involved:

```yaml
telemetry:
  track:
    - on: skill
      match: my-review-skill
      record: "whether it uncovered bugs, findings count, iteration for the branch"
    - on: agent                 # skills that run as dedicated subagents
      match: my-review-agent
    - on: merge
  # retention: 180d      # opt-in; default keeps everything
```

Skills that run as dedicated subagents are invisible to the `skill` trigger —
track those with `on: agent`, matched by subagent type.

The generated hooks wire the deterministic layer automatically, and capture is
identical across Claude Code, Codex, and OpenCode — the config is the only knob:
tracked `skill` runs (the Skill/skill tool), `agent` subagent spawns (the Task/task
tool, matched by `subagent_type` — the only signal for skills that run as
dedicated subagents or set `disable-model-invocation`), `merge` commands (guarded
Bash matcher), and `session` start/end (end also ships the spool via a bare
`agentcomm emit --flush`). The harness payloads are normalized and handed to
`agentcomm hook telemetry`, so the rule matching lives in the CLI once; the session
briefing injects each rule's `record:` text so the model knows what to self-report.
The `on`/`match` layer never depends on the model — if it's in the config, it
fires. (Only task-list tracking differs: Codex and OpenCode have no task events.)

## Capture is precise about what it records

`merged` events fire only for real `git merge` / `gh pr merge` invocations —
plumbing like `merge-base` and unwinding via `merge --abort` don't count, and
commands the harness marked as failed are skipped — and they carry the merged
source branch or PR number in `attrs`. `agent-ran` events resolve their `ref`
from worktree paths named in the subagent prompt (the session's own cwd often
sits on the default branch while the work happens in a sibling worktree),
falling back to the cwd branch, with provenance in `attrs.ref_source`. And when
a harness fires the same hook twice for one occurrence — the same hook
registered in two settings scopes is the common case — the twins collapse:
events dedup on identity within a 10-second window at both flush and read time.

## Recording is free at capture time

```bash
agentcomm emit --type skill-outcome --name my-review-skill \
  --ref "$(git branch --show-current)" \
  --attrs '{"found_bugs":true,"findings":3}'
```

That appends to a local spool — no network. Batches ride the **next bus write the
CLI makes anyway** (`register`, `send`, `broadcast`), so the backend sees its usual
write cadence with fatter payloads (worst case a spool tail is lost — by design).
Analysis is `agentcomm events --json` piped into whoever asks the question.

Aging events out is explicit — see
[housekeeping](backends.md#housekeeping--who-cleans-the-bus-and-how).
