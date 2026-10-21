---
type: regex
target: { source: file, path: src/db.ts }
pattern: 'new DatabaseSync\('
match: not_contains
---
