---
description: The user names the recorded SQLite decision and overrides it on purpose. The plugin should not make the agent ask again.
plugins: ["../../../../../plugin"]
max_turns: 20
timeout_seconds: 600
allowed_tools: [Read, Glob, Grep, Skill]
tags: [delivery]
---

保存先を Postgres に変えます。前に SQLite の 1 ファイルにした決定があるのは知っていますが、家族で本棚を共有したいので、今回ははっきり Postgres にしてください。src/db.ts の open を、pg の Pool を返すように書き換えてください。
