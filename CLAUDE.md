<!-- agentcomm -->
## Agent coordination (agentcomm)

This repo has a message bus for AI agents. When working here:

- At session start: `agentcomm register --as <descriptive-name>` and check
  your inbox (`agentcomm inbox --as <name> --json`) — instructions may be
  waiting. The bus is auto-detected from this repo; `agentcomm describe`
  explains it, `agentcomm conventions` has the team rules.
- Coordinate with other agents via `send`/`wait` (subjects: task, ack,
  done, question, status; reply on the sender's --thread).
- Always check your inbox before reporting work done.
