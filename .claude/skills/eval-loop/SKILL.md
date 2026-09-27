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
- [ ] 3. Fire each routine at least twice with the task prompt; run codex.ts for none, search, gold
- [ ] 4. Save each run's log (RemoteTrigger get_run_log), then collect
- [ ] 5. Grade final answers blind (Claude and Codex), compare
- [ ] 6. For each failure: acceptance case first (red), fix, verify, rerun the same task
```

1. A fixture is built through the record server's own functions: `node evals/cloud/fixture.ts new|harvest|check|save`. Keep each PR's record JSON
   next to the database (`~/.cache/sphica-eval/fixtures/pr<N>.record.json`) so it can be rebuilt. Anchor records by the trace contract
   (`plugin/skills/trace/SKILL.md`), or delivery has nothing to show
2. Move the last `loop.json`, `build/manifest.json`, `codex-runs/`, and `logs/` into `archive/<loop>/` (deleted branches cannot be collected again).
   Then `node evals/cloud/build.ts --project <name>`, and for each slot delete its `claude/eval-*` branches and, from
   `~/.cache/sphica-eval/build/eval-shelf-N`, `git fetch -q origin main && git push --force-with-lease origin main` (the build starts a new history). The build fails if the inject slot's delivery hook logs nothing (the smoke test)
3. Fire with RemoteTrigger `run` and body `{"text": "<task prompt>"}`. Codex: `node evals/cloud/codex.ts --repo eval-shelf-N --task <id>` (not the
   inject slot; Codex has no delivery hooks yet)
4. Save each run's log to `~/.cache/sphica-eval/logs/<branch session id>.log` first (collect reads it for the failure signals). Then
   `node evals/cloud/collect.ts` writes `~/.cache/sphica-eval/loop.json`: hidden tests, delivered unit keys, final answers, and failure signals
5. Grade the final answer, not only the patch: a run in an old checkout often stops at a plan because that checkout's CLAUDE.md demands the owner's Go.
   Give graders the task's `expect` and the answers without their conditions

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
