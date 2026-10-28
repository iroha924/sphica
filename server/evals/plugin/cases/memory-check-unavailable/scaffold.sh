#!/bin/bash
set -euo pipefail
node "$(dirname "$0")/../../seed.ts"
mkdir -p "$HOME/notes"
cat > "$HOME/notes/MEMORY.md" <<'EOF'
- The owner prefers short commit subjects in English.
- Store timestamps in local time (JST) so the UI can show them as they are.
EOF
node -e 'const { DatabaseSync } = require("node:sqlite"); const d = new DatabaseSync(process.env.HOME + "/.sphica/sphica.db"); d.exec("pragma user_version = 9999"); d.close();'
