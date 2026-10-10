// Copyright (c) 2026 iroha924 and contributors
// SPDX-License-Identifier: MIT

export const NODE = {
  version: "v24.15.0",
  file: "node-v24.15.0-linux-x64.tar.xz",
  sha256: "472655581fb851559730c48763e0c9d3bc25975c59d518003fc0849d3e4ba0f6",
};

// The shell scripts each evaluation slot carries in .tools, run on the cloud VM (Linux) or by the local runners. They are evaluation
// infrastructure, not shipped code.
export const NODE_SH = `#!/bin/sh
# Runs Node >= 24.15: the system's when new enough, else the bundled linux-x64 build, checked against its sha256 before first use.
set -e
here=$(cd "$(dirname "$0")" && pwd)
if command -v node >/dev/null 2>&1 && node -e 'const [a,b]=process.versions.node.split(".").map(Number);process.exit(a>24||(a===24&&b>=15)?0:1)' 2>/dev/null; then
  exec node "$@"
fi
dir="$HOME/.cache/eval-node/${NODE.version}"
if [ ! -x "$dir/bin/node" ]; then
  echo "${NODE.sha256}  $here/${NODE.file}" | sha256sum -c - >/dev/null
  tmp=$(mktemp -d "$HOME/.cache/eval-node-XXXXXX" 2>/dev/null || { mkdir -p "$HOME/.cache" && mktemp -d "$HOME/.cache/eval-node-XXXXXX"; })
  tar -xJf "$here/${NODE.file}" -C "$tmp" --strip-components=1
  mkdir -p "$(dirname "$dir")"
  mv "$tmp" "$dir" 2>/dev/null || rm -rf "$tmp"
fi
exec "$dir/bin/node" "$@"
`;

/** Points Sphica at a writable copy of the fixture (the committed original stays as its hash says). */
export const SPHICA_SH = `#!/bin/sh
set -e
here=$(cd "$(dirname "$0")" && pwd)
# A local runner names its run's copy; otherwise keyed by the fixture, so a reused container never serves an earlier fixture's copy
export SPHICA_DB="\${EVAL_SPHICA_DB:-\${TMPDIR:-/tmp}/eval-sphica/$(cat "$here/fixture.id")/sphica.db}"
if [ ! -f "$SPHICA_DB" ]; then
  mkdir -p "$(dirname "$SPHICA_DB")"
  cp "$here/fixture.db" "$SPHICA_DB.$$" && mv "$SPHICA_DB.$$" "$SPHICA_DB"
fi
exec sh "$here/node.sh" "$@"
`;

/** Every hook call leaves a receipt, so a run shows which hooks ran and what they returned. */
export const HOOK_SH = `#!/bin/sh
# usage: hook.sh <name> [command...]  Reads the hook input, runs the command with it, and records a receipt of both.
here=$(cd "$(dirname "$0")" && pwd)
name="$1"; shift
# A local runner gives each run its own directory; the cloud VM has only TMPDIR
run="\${EVAL_RUN_DIR:-\${TMPDIR:-/tmp}}"
log="$run/eval-receipts.jsonl"
# A cloud container can be reused across runs: session start clears the receipts and the gold marker an earlier run left. The database copy
# stays (the MCP server may have opened it before this hook runs); the collector counts only deliveries made after this session started
if [ "$name" = start ]; then rm -f "$log" "$run/eval-gold-given"; fi
input=$(cat)
if [ "$#" -gt 0 ]; then output=$(printf '%s' "$input" | "$@" 2>/dev/null); else output=""; fi
LOG="$log" sh "$here/node.sh" -e 'const [name, input, output] = process.argv.slice(1); require("node:fs").appendFileSync(process.env.LOG, JSON.stringify({ name, at: new Date().toISOString(), node: process.version, input: JSON.parse(input || "{}").hook_event_name ?? null, prompt: String(JSON.parse(input || "{}").prompt ?? "").slice(0, 2000) || undefined, file: JSON.parse(input || "{}").file_path, memory: JSON.parse(input || "{}").memory_type, output }) + "\\n")' "$name" "$input" "$output" 2>/dev/null || true
printf '%s' "$output"
`;

/**
 * Gold condition: the task's records, given once at the first prompt in the same shape the delivery hook uses. The task is found by its
 * prompt text inside the fired prompt, so one repository serves every task.
 */
export const GOLD_SH = `#!/bin/sh
here=$(cd "$(dirname "$0")" && pwd)
mark="\${EVAL_RUN_DIR:-\${TMPDIR:-/tmp}}/eval-gold-given"
[ -f "$mark" ] && exit 0
touch "$mark"
sh "$here/node.sh" -e 'let s = ""; process.stdin.on("data", (d) => (s += d)).on("end", () => { const prompt = JSON.parse(s || "{}").prompt ?? ""; const gold = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8")); const hit = gold.find((g) => prompt.includes(g.prompt)); if (hit?.text) process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: hit.text } })); })' "$here/gold.json"
`;

/** At the end of the turn, commits the work with the receipts and delivery log, and pushes it to claude/eval-<session>. */
export const FINISH_SH = `#!/bin/sh
here=$(cd "$(dirname "$0")" && pwd)
input=$(cat)
sid=$(printf '%s' "$input" | sh "$here/node.sh" -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(String(JSON.parse(s||"{}").session_id||"unknown").replace(/[^A-Za-z0-9_-]/g,"")))')
cd "$(git -C "$here" rev-parse --show-toplevel)" || exit 0
mkdir -p .eval
cp "\${TMPDIR:-/tmp}/eval-receipts.jsonl" .eval/receipts.jsonl 2>/dev/null || true
# The final answer is graded too (a run that stops for approval leaves no patch); older hosts lack last_assistant_message, so read the transcript
# Every stop's answer is kept: a stop hook can make the agent answer again, and the later answer is often only about committing
printf '%s' "$input" | sh "$here/node.sh" -e 'const fs=require("node:fs");let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const i=JSON.parse(s||"{}");let a=i.last_assistant_message??"";if(!a&&i.transcript_path)for(const l of fs.readFileSync(i.transcript_path,"utf8").split("\\n")){try{const e=JSON.parse(l);const t=e.type==="assistant"?(e.message?.content??[]).filter(c=>c.type==="text").map(c=>c.text).join("\\n"):"";if(t)a=t}catch{}}const f=".eval/answer.md";const prev=fs.existsSync(f)?fs.readFileSync(f,"utf8"):"";if(a&&!prev.includes(a))fs.writeFileSync(f,prev?prev+"\\n\\n"+a:a)})' 2>/dev/null || true
db="\${TMPDIR:-/tmp}/eval-sphica/$(cat "$here/fixture.id" 2>/dev/null)/sphica.db"
if [ -f "$here/fixture.id" ] && [ -f "$db" ]; then
  sh "$here/node.sh" -e 'const { DatabaseSync } = require("node:sqlite"); const db = new DatabaseSync(process.argv[1], { readOnly: true }); process.stdout.write(JSON.stringify(db.prepare("select d.event, d.outcome, d.path, d.chars, d.at, (select json_group_array(u.key) from delivery_unit x join unit u on u.id = x.unit_id where x.delivery_id = d.id) as units from delivery d order by d.id").all()))' "$db" > .eval/deliveries.json 2>/dev/null || true
fi
git add -A >/dev/null 2>&1
# Files the agent wrote under ignored paths (a plan in .claude/plans) are part of its answer; installed dependencies and build
# output are not (a run that installed node_modules could not push its result)
git ls-files -z --others --ignored --exclude-standard | grep -zvE '^[.]tools/|^plugin/(dist|db)/|(^|/)node_modules/' | xargs -0 -r git add -f >/dev/null 2>&1
# The same for dependencies a checkout without an ignore file staged above
git ls-files -z --cached | grep -zE '(^|/)node_modules/' | xargs -0 -r git rm -q --cached >/dev/null 2>&1
# The checkout's own hooks (lefthook, once the agent installed it) must not keep the run's result from being collected
git -c core.hooksPath=/dev/null -c user.name=eval -c user.email=eval@example.invalid commit -qm "eval result" --allow-empty >/dev/null 2>&1
git push -q --force origin "HEAD:refs/heads/claude/eval-$sid" >/dev/null 2>&1 || true
`;
