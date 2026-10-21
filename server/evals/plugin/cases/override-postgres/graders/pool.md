---
type: regex
target: { source: file, path: src/db.ts }
pattern: '(?:function open\s*\([^)]*\)[^{]*\{[^}]*|const open\s*=[^;{]*(?:\{[^}]*)?)new (?:pg\.)?Pool\('
---
