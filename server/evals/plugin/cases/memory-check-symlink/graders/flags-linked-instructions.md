---
type: llm
---

PASS if the reply flags the line about storing timestamps in local time in a user-level instruction file (~/.claude/CLAUDE.md or AGENTS.md in the Codex home, both symbolic links into a config repository) as going against trace:s-en-dates/utc.
FAIL if the reply says both of those files were not found, or flags no such line.
