---
name: eval-loop
description: Runs one turn of Sphica's evaluation loop on real agents. Builds the four condition slots (none, search, inject, gold) with server/evals/cloud/build.ts, fires the cloud routines for Claude, replays Codex locally, collects branches and run logs with collect.ts, grades the final answers blind, and turns each failure into an acceptance case before fixing. Use when running or rerunning the cloud or Codex evaluation, adding an evaluation task or fixture, or when an eval run looks wrong (nothing delivered, a tool unavailable, every run stopping at a plan). Not for the acceptance cases alone (bun run verify runs them) or for shipping (plugin-release).
---

# Run the evaluation loop

## Triggers

- Running or rerunning a task in `server/evals/cloud/tasks.json` on Claude (cloud routines) or Codex (local)
- Adding a task, a project, or a fixture database for the evaluation
- A run's result looks wrong: nothing delivered in the inject slot, the gold record ignored, a Sphica tool missing

## Does not trigger

- Adding or running acceptance cases only (`server/evals/acceptance/`; `bun run verify` runs them)
- Shipping the package (`plugin-release`)

## Where things are

| What | Where |
|---|---|
| Tasks, prompts, gold keys, hidden tests | `server/evals/cloud/tasks.json` |
| Slot builder, collector, Codex replay, fixture writer | `server/evals/cloud/build.ts`, `collect.ts`, `codex.ts`, `fixture.ts` |
| Built slots, fixtures, Codex runs, run logs, old results | `~/.cache/sphica-eval/` (`build/`, `fixtures/`, `codex-runs/`, `logs/`, `archive/`) |
| Routine ids per slot | `~/.cache/sphica-eval/routines.json` |
| Routine token | `~/.config/sphica-eval`. Never print it; fire with the RemoteTrigger tool instead |

Slots are the owner's private repositories `iroha924/eval-shelf-1..4` (none, search, inject, gold). Creating repositories or routines, and spending
the cloud credits beyond an approved loop, need the owner's approval first. One cloud run costs roughly $0.15 to $0.30.

## One loop

Run the `node evals/cloud/*.ts` commands from `server/`.

```text
Loop progress:
- [ ] 1. Fixture current with db/schema.sql (rebuild after any schema change)
- [ ] 2. Archive the last loop, build, delete old claude/eval-* branches, push the 4 slots
- [ ] 3. Fire each routine at least twice with the task prompt; run codex.ts for all four slots
- [ ] 4. Save each run's log to `~/.cache/sphica-eval/logs/<branch session id>.log` first (collect reads it for the failure signals and for
   `found`). Then `node evals/cloud/collect.ts --fired <slot>=<n> ...` (one per Claude slot, with how many times it was fired) writes
   `~/.cache/sphica-eval/loop.json`: per run the hidden tests, the patch, the final answer, and four signals kept apart: `delivered`, `found`,
   Codex's `answer_format`, and `excluded` with the reason. Every Codex run that wrote `started.json` and every fired Claude run is a row,
   so a failed or missing run stays in the denominator. A missing log makes `found` unknown, never no
5. `node evals/cloud/grade.ts` grades each result row blind through `grade.schema.json` (the grader sees the task, `expect`, `against`, the
   answer, and the patch; never the model or the condition) and writes `~/.cache/sphica-eval/grades.json` with a table by model and
   condition. A grade that fails its schema is `ungraded`, not a score. Report both models side by side with n: started, excluded,
   ungraded, the score spread, each signal including unknown, and the tracked failure (delivered or found, and still made the change
   `against` describes). Grade the final answer and the patch, not the answer alone: a run in an old checkout often stops at a plan
   because that checkout's CLAUDE.md demands the owner's Go

## Traps seen in earlier loops

- **Keep the bundle names `.js`.** `deliver.ts` runs only when its entry path matches `deliver.(ts|js)`; a slot that renamed it to `.mjs` delivered nothing
  for two loops with no error. `.tools/dist/package.json` makes the `.js` files ESM
- Cloud containers are reused across runs and routines, `$TMPDIR` included. The slots key their database copy by the fixture hash (`.tools/fixture.id`);
  a shared path once served an earlier project's database, which `status` showed as the wrong counts. Check `status` in a run log when numbers look off
- A schema change leaves an old fixture's CHECKs behind; delivery logs then fail silently and per-session limits stop working. Rebuild the fixture
- Gold text must be whole. Pointing it at a Sphica tool the slot lacks made both models reject the record as an unverifiable claim
- Unattended runs sent push notifications to the owner; the slot settings deny `PushNotification`. The routines also carry the Claude_Docs and
  Claude_Code_Remote connectors, which cannot be removed; they are the same in every condition
- The gold slot's scaffolding is in the checkout (`.tools/gold.json`, `gold.sh`). A run that reads it can call the gold record forged; one
  Claude run did. Count those runs separately rather than as a Sphica failure, until the gold slot delivers without readable scaffolding
- A hook tested from a shell inside Claude Code inherits `CLAUDE_CODE_ENTRYPOINT` and `SPHICA_PARENT_SESSION`; unset both, or owner-turn checks
  drop the call and the hook prints nothing
- One run per condition is too weak to credit a difference to Sphica. Run at least two, and say how many in the report
- Before leaving a wait loop in the background, run its exit condition once by hand; a wrong `until` condition kept one polling for 45 minutes
