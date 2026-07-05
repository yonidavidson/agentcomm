<!-- agentcomm -->
## Agent coordination (agentcomm)

This repo has a message bus for AI agents. When working here:

- At session start: register under a STABLE alias derived from your operator
  and tool — `agentcomm register --as <git-user>-claude` (or -cursor, -ci…).
  Same alias every session: it is your mailbox address, and messages sent to
  yesterday's name go unread. Never reuse the human's bare alias — inbox
  reads consume, so sharing an address steals each other's mail.
- Then check your inbox (`agentcomm inbox --as <alias> --json`) —
  instructions may be waiting. The bus is auto-detected from this repo;
  `agentcomm describe` explains it, `agentcomm conventions` has the rules.
- Coordinate with other agents via `send`/`wait` (subjects: task, ack,
  done, question, status; reply on the sender's --thread).
- Always check your inbox before reporting work done.
