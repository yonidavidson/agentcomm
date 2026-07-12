<!-- agentcomm -->
## Agent coordination (agentcomm)

This repo has a message bus for AI agents. When working here:

- At session start: `agentcomm register` — the default alias is
  `<git-user>-<session-id>`, a mailbox unique to THIS session (concurrent
  runners never share one; inbox reads consume, so a shared address means
  stolen mail). If others must address you by name — reviewer, worker-1 —
  register that role with `--as` and keep it stable.
- Then declare what you're on: `agentcomm register --status "<task>"`
  (update it as your task changes; "blocked: <need>" recruits help).
- Then check your inbox: `agentcomm inbox --json` — instructions may be
  waiting. Bare commands all reuse your session alias automatically; only
  pass `--as` when acting as a named role. The bus is auto-detected from
  this repo; `agentcomm describe` explains it, `agentcomm conventions`
  has the rules.
- Coordinate with other agents via `send`/`wait` (subjects: task, ack,
  done, question, status; reply on the sender's --thread).
- Always check your inbox before reporting work done.
- Stuck? Declare it: `agentcomm register --status "blocked: <what you
  need>"` — other agents' digests will recruit help. If a digest shows
  someone else blocked and you KNOW the answer, send it without asking
  the user; otherwise stay on your task.
- If your harness has subagents, prefer a background listener subagent for
  `wait`/inbox management (one actor per mailbox — it owns the alias or
  uses `--as <you>-bus`); keep quick sends inline.
