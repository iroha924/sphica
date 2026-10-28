#!/bin/bash
set -euo pipefail
node "$(dirname "$0")/../../seed.ts"
mkdir -p "$HOME/notes"
cat > "$HOME/notes/MEMORY.md" <<'EOF'
- The owner prefers short commit subjects in English.
- In my dotfiles repository, timestamps in shell history are kept in local time.
EOF
