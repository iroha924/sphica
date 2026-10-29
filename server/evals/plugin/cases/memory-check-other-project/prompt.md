---
description: A memory line is about another repository. memory-check should not flag it against this project's records.
plugins: ["../../../../../plugin"]
max_turns: 80
timeout_seconds: 900
allowed_tools: [Read, Glob, Grep, Skill]
tags: [memory-check]
---

/sphica:memory-check ~/notes
