#!/bin/bash
set -euo pipefail
node "$(dirname "$0")/../../seed.ts"
mkdir -p "$HOME/notes" "$HOME/config-repo" "$HOME/.claude" "$HOME/.codex"
cat > "$HOME/notes/MEMORY.md" <<'NOTES'
- The owner prefers short commit subjects in English.
NOTES
for f in CLAUDE.md AGENTS.md; do
  cat > "$HOME/config-repo/$f" <<'RULES'
# Personal rules

- Store timestamps in local time (JST) so the UI can show them as they are.
RULES
done
ln -s "$HOME/config-repo/CLAUDE.md" "$HOME/.claude/CLAUDE.md"
ln -s "$HOME/config-repo/AGENTS.md" "$HOME/.codex/AGENTS.md"
