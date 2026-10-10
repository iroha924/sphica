# Post-shell delivery on real hosts

Checked on 2026-10-10 with Claude Code 2.1.296 and codex-cli 0.162.0 on macOS, at the bundle of commit 1d592b22.
The harness (`shell-write-harness.ts`) checks what the hook prints.
These runs check that each host puts that text into the conversation before its next model request.

## Setup

- A temporary checkout whose origin is `github.com/o/r`, with two owner decisions in a temporary database:
  - `trace:ext-real/utc` on `src/dates.ts`
  - `trace:ext-real/epoch` on `src/times.ts`
- `tools/gen.cjs` and `tools/gen2.cjs` append to those files and build the file name in code, so no command names a file and Pre delivers nothing.
- Every run sets `SPHICA_HOME`, `SPHICA_DB`, and `SPHICA_SHELL_WRITE_DELIVERY=on` in its environment.
- Claude Code: `claude -p` with `--plugin-dir plugin`, the installed `sphica@sphica` turned off through `--settings`, and `--allowedTools` limited to the case's commands.
- Codex: `codex exec -s workspace-write` with a temporary `CODEX_HOME`. That home has the owner's model settings, a link to the owner's `auth.json`, and this bundle installed from a local marketplace (the installed `deliver.js` is byte-identical to `plugin/dist/deliver.js`).
  - Hooks ran with `--dangerously-bypass-hook-trust`, so Codex's trust step for the new hook is not covered here; `codex-trust.test.ts` checks that the hooks shipped before keep their keys and hashes.

## Cases

Each row names the session; the order is read from its transcript (Claude Code) or rollout log (Codex).

| host | case | session | what the log shows |
|---|---|---|---|
| Claude Code | a write | bc4122b0-1e9f-47d6-b972-f3d49927b501 | Bash tool_result, then a `hook_additional_context` attachment from PostToolUse with the shell-write lead naming `src/dates.ts`, then the reply quoting `trace:ext-real/utc` |
| Claude Code | a write, then exit 3 | 0a26c14b-f71d-481a-9192-399ad49ea461 | tool_result, then the attachment from PostToolUseFailure, then the reply quoting `trace:ext-real/utc` |
| Claude Code | two Bash calls in one message | 93e0ad9e-9ade-4ba8-8054-cc5e3f67afb1 | each tool_result is followed by its PostToolUse attachment (`src/dates.ts`, then `src/times.ts`), both before the reply quoting both keys |
| Codex | a write | 01a123b5-4577-7ab0-ab6c-26588f2bcbfc | the `exec` call, then a developer message with the shell-write lead naming `src/dates.ts`, then the call output, then the reply quoting `trace:ext-real/utc` |
| Codex | two commands in one `exec` (Promise.allSettled) | 01a123b5-9f34-76f0-93e6-1d516cb7bdf7 | one developer message naming both files before the reply quoting both keys; the trial log shows the second Post had nothing left to bring |
| Codex | a 20-second command, one call | 01a123b5-c562-79b0-9e3f-c3be419c9f9d | the model asked for a 30-second yield, so no poll: the developer message precedes the reply |
| Codex | a 20-second command through polls | 01a123b6-69b9-7511-814b-b9f1e40ba644 | started with a 2-second yield and polled 3 times with `write_stdin`; the developer message comes with the poll that saw the command exit, before the reply. The trial log has one `post_shell` line for the command |

Every trial log line that delivered has `logged: true`. The one that delivered nothing, the second Post of the parallel Codex run, has `logged: null`. In each run the reply quoted the keys that the log shows were delivered.

## Not covered

- Windows hosts: the Windows CI job runs the harness with Git Bash and PowerShell commands, but no real Claude Code or Codex session ran there.
- Codex's hook trust prompt for the new PostToolUse hook (see Setup).
