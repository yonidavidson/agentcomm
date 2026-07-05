<!-- agentcomm -->
## Agent coordination (agentcomm)

This repo has a message bus for AI agents. When working here:

- At session start: `agentcomm register` — the default alias is
  `<git-user>-<session-id>`, a mailbox unique to THIS session (concurrent
  runners never share one; inbox reads consume, so a shared address means
  stolen mail). If others must address you by name — reviewer, worker-1 —
  register that role with `--as` and keep it stable.
- Then check your inbox (`agentcomm inbox --as <alias> --json`) —
  instructions may be waiting. The bus is auto-detected from this repo;
  `agentcomm describe` explains it, `agentcomm conventions` has the rules.
- Coordinate with other agents via `send`/`wait` (subjects: task, ack,
  done, question, status; reply on the sender's --thread).
- Always check your inbox before reporting work done.
