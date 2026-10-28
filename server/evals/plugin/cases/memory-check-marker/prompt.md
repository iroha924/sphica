---
description: A CLAUDE.md line carries a marker of an active record and says the opposite. memory-check should flag it although look would not.
plugins: ["../../../../../plugin"]
max_turns: 80
timeout_seconds: 900
allowed_tools: [Read, Glob, Grep, Skill]
tags: [memory-check]
---

/sphica:memory-check ~/notes
