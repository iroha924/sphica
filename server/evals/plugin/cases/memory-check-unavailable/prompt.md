---
description: Sphica's database cannot be opened. memory-check should report the places as not checked, never as no conflicts.
plugins: ["../../../../../plugin"]
max_turns: 80
timeout_seconds: 900
allowed_tools: [Read, Glob, Grep, Skill]
tags: [memory-check]
---

/sphica:memory-check ~/notes
