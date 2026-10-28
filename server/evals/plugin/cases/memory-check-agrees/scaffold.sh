#!/bin/bash
set -euo pipefail
node "$(dirname "$0")/../../seed.ts"
mkdir -p "$HOME/notes"
cat > "$HOME/notes/MEMORY.md" <<'EOF'
- The owner prefers short commit subjects in English.
- Do not add telemetry: the owner decided against sending usage data.
EOF
