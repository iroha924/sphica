---
paths:
  - "**/*.ts"
  - "**/*.tsx"
  - "**/*.mjs"
  - "**/*.css"
  - "**/*.sql"
  - "**/*.yml"
  - "**/*.yaml"
  - "**/.gitignore"
---

# Comments

- 1 to 3 lines, only what the code cannot say: why it is this way, a constraint, a trap. Put anything longer in a Skill, not in the comment <!-- invariant: comment-length -->
- Write the reason itself. Do not point to issues, pull requests, plans, or commits by number, URL, or path <!-- invariant: comment-refs -->
- Describe the code as it is. Do not tell its history (what it used to be, what changed, when): git and Sphica's records keep that <!-- invariant: comment-history -->
- At most one bold phrase per file
- In config files, do not write what the setting itself says. Write only the outside context the file cannot show (where it is generated from, why it does not rely on a global setting)
- Delete stale comments in a file you touch, in the same change
