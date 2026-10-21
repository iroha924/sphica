#!/bin/bash
set -euo pipefail
here=$(dirname "$0")
exec node "$here/../../seed.ts" "$here/steps.json"
