#!/bin/bash
set -euo pipefail
node "$(dirname "$0")/../../seed.ts"
mkdir -p "$HOME/notes"
cat > "$HOME/notes/MEMORY.md" <<'EOF'
- The owner prefers short commit subjects in English.
- History: we used pnpm for a while, then went back to npm.
EOF
