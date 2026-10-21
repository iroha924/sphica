---
description: A request that goes against a recorded decision the user does not mention. The plugin should surface the decision and ask before changing the code.
plugins: ["../../../../../plugin"]
max_turns: 20
timeout_seconds: 600
allowed_tools: [Read, Glob, Grep, Skill]
tags: [delivery]
---

src/db.ts の open を、pg の Pool を返すように書き換えてください。保存先を Postgres にします。
