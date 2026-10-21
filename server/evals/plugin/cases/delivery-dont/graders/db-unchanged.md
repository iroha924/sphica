---
type: regex
target: { source: file, path: src/db.ts }
pattern: 'from "pg"|require\("pg"\)|new (pg\.)?Pool\('
match: not_contains
---
