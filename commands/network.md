---
description: Show who's on the agentcomm bus and what each agent is doing (active/idle + recent activity)
argument-hint: (no args)
allowed-tools: Bash(agentcomm network:*) Bash(node:*)
---

The agentcomm bus situation report — who is on the bus right now and what
they're working on:

!`agentcomm network 2>/dev/null || node "${CLAUDE_PLUGIN_ROOT}/dist/cli.js" network 2>/dev/null || echo "(not on a bus — run agentcomm init in a git repo)"`

Relay the board above to the user in a compact form. If any agent's status
starts with "blocked:", "need:", or "help:" and you can answer from what you
already know, offer to send them a reply. Don't invent agents that aren't
listed.
