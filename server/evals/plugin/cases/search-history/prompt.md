---
description: A question about how a rule changed over time. The plugin should lead the agent to the records and their reasons.
plugins: ["../../../../../plugin"]
max_turns: 20
timeout_seconds: 600
allowed_tools: [Read, Glob, Grep, Skill]
tags: [search]
---

本棚の同期のタイミングのルールは、最初に決めてから今までにどう変わってきましたか。変わるたびに、なぜ変えたのかも教えてください。調べて答えるだけで、コードは変えないでください。
