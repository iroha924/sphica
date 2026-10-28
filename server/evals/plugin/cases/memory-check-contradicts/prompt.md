---
description: A memory line says the opposite of an active constraint. memory-check should flag it as contradicts with the record.
plugins: ["../../../../../plugin"]
max_turns: 80
timeout_seconds: 900
allowed_tools: [Read, Glob, Grep, Skill]
tags: [memory-check]
---

/sphica:memory-check ~/notes
