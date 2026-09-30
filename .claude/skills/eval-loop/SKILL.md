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
| Slot builder, firing plan, collector, Codex replay, grader, report, fixture writer | `server/evals/cloud/build.ts`, `fire.ts`, `collect.ts`, `codex.ts`, `grade.ts`, `report.ts`, `fixture.ts` |
| Builds (slots, `plan.json`, `loop.json`, `grades.json`), fixtures, Codex runs, run logs, old results | `~/.cache/sphica-eval/` (`builds/<build id>/`, `fixtures/`, `codex-runs/`, `logs/`, `archive/`) |
| Routine ids per slot | `~/.cache/sphica-eval/routines.json` |
| Routine token | `~/.config/sphica-eval`. Never print it; fire with the RemoteTrigger tool instead |

Slots are the owner's private repositories `iroha924/eval-shelf-1..4` (none, search, inject, gold). Creating repositories or routines, and spending
the cloud credits beyond an approved loop, need the owner's approval first. One cloud run costs roughly $0.15 to $0.30.

## One loop

Run the `node evals/cloud/*.ts` commands from `server/`.

```text
Loop progress:
- [ ] 0. Estimate the cost and get the owner's word before firing
- [ ] 1. Fixture current with db/schema.sql (rebuild after any schema change)
- [ ] 2. Build, delete old claude/eval-* branches, push the 4 slots
- [ ] 3. Fire every row of the firing plan; run codex.ts for the same tasks and conditions
- [ ] 4. Save the logs, collect
- [ ] 5. Grade with both graders
- [ ] 6. For the counterfactual, repeat 2 to 5 with --variant swapped
- [ ] 7. Report
```

0. Count the Claude runs the firing plan will ask for (`plan.json` has one row per task, condition, and try) and multiply by $0.15 to $0.30.
   Show the owner the count and the range before firing: spending beyond an approved loop needs their word. Codex runs and grading use the
   owner's subscriptions
1. For tsundoku the fixture is built from `tasks.json`'s `fixture.cases` and `fixture.setups` (a case's `given` cases are not run, so list them
   in order). For sphica it is a harvested database; rebuild it after a schema change
2. `node evals/cloud/build.ts --project <project> [--variant original|swapped] [--runs <n>]` writes `~/.cache/sphica-eval/builds/<build id>/`: the four
   slots, `manifest.json` (with the build id and variant), and `plan.json`. It never rebuilds an existing directory; each build keeps its own.
   Push one build's slots at a time
3. For each row, `node evals/cloud/fire.ts <build dir>` marks the next unfired row fired and prints its slot and prompt; fire that slot's
   routine (`routines.json`) with RemoteTrigger right after (`--condition gold` fires only a swapped build's gold rows). For Codex, `node evals/cloud/codex.ts --build <build dir> --repo <slot> --task <task>`;
   each run records the build id, so runs of another build are left out when collecting
4. Save each run's log to `~/.cache/sphica-eval/logs/<branch session id>.log` first (collect reads it for the signals). Then
   `node evals/cloud/collect.ts --build <build dir>` writes `<build dir>/loop.json`. It takes only branches built on this build, pairs them with
   the fired rows by task and condition in firing order, and keeps a fired row with no branch as an excluded row with its task and condition,
   so the denominator holds every run asked for. Per run: the hidden tests (not run for a swapped build), the patch, the final answer,
   `delivered`, `found`, Codex's `answer_format`, `excluded` with the reason, and per gold key `gold_signals` (`in_delivery`, `in_search`,
   `read`). A signal that cannot be told (no log, a broken event, a result not tied to one tool) is unknown, never no
5. `node evals/cloud/grade.ts --loop <build dir>/loop.json` grades each result row blind through `grade.schema.json` (Codex with its own HOME and
   CODEX_HOME) and again with Claude (`claude -p` in an empty directory with no settings sources, MCP servers, tools, or skills; `--second none`
   skips it). The grader sees the task, `expect`, `against`, the record shown (counterfactual tasks' gold runs only), the answer, and the patch;
   never the model or the condition. Codex's grade is the one counted; Claude's is kept beside it for agreement. A grade that fails its schema, or
   answers `not_applicable` where it does not fit (`implements_rejected` and `proposes_rejected` without an `against`, `followed` without a record
   shown), is `ungraded`, not a score. build.ts drops the slot's "Before implementing" section (the owner's Go) and stops if a copy still asks for
   it, so a stop at a plan is the model's own. The JSON schema files are written from the zod schemas: `node evals/cloud/schema-check.ts --write`
6. The counterfactual: `build.ts --variant swapped` builds only the tasks in `tasks.json`'s `swapped.tasks`, without the records the original gold
   came from and with the swapped record instead. Its runs are graded on whether they followed the record they were shown, not on the original expectation
7. `node evals/cloud/report.ts <build dir>/grades.json [<swapped build dir>/grades.json]` prints the table by model and condition; the same by
   language pair, word overlap (`overlap` in tasks.json, labelled by hand), and whether the task has gold; gold minus inject per task and model
   with every run (fewer than 3 graded runs a side is marked preliminary); re-proposals; the counterfactual; grader agreement with each
   disagreement; and each gold key's signals. Report both models side by side with n, excluded, and ungraded
8. To credit a wording change, measure old and new on the same slots and records: check out the commit before the change in a worktree,
   run its `build.ts` (old) and HEAD's (new), and run steps 2 to 7 for each. Tasks: the conflict tasks (`against` set) and pilot-display (a related
   record the request does not conflict with). inject and gold 3 runs each, none and search 2 each, both models. Ship the wording only if, on the
   new run, both models have tracked failure 0 in the conflict tasks' inject and gold, pilot-display is implemented (score >= 1) in every graded
   run, and none and search show no `stopped_at_plan`; report 3 runs as preliminary

For search changes alone, use the offline benchmark first: `node evals/retrieval/run.ts --compare <ref>` builds each side's index with that
side's `terms()` and search, and prints recall@k and MRR (questions with gold) and how often a question with no gold returned anything, overall
and by language pair and overlap. The experiment's issue names the main measure and the drop it allows before the numbers are taken.

## Traps seen in earlier loops

- **Keep the bundle names `.js`.** `deliver.ts` runs only when its entry path matches `deliver.(ts|js)`; a slot that renamed it to `.mjs` delivered nothing
  for two loops with no error. `.tools/dist/package.json` makes the `.js` files ESM
- Cloud containers are reused across runs and routines, `$TMPDIR` included. The slots key their database copy by the fixture hash (`.tools/fixture.id`);
  a shared path once served an earlier project's database, which `status` showed as the wrong counts. Check `status` in a run log when numbers look off
- A schema change leaves an old fixture's CHECKs behind; delivery logs then fail silently and per-session limits stop working. Rebuild the fixture
- Gold renders its records with the delivery renderer (`recordLines` in deliver.ts) and points to no Sphica tool: a pointer to a tool the slot lacks made both models reject the record as an unverifiable claim. build.ts stops if a gold record's body or reason would be cut
- A task's prompt must not contain another task's prompt: collect and gold find the task by the prompt text
- Unattended runs sent push notifications to the owner; the slot settings deny `PushNotification`. The routines also carry the Claude_Docs and
  Claude_Code_Remote connectors, which cannot be removed; they are the same in every condition
- The gold slot's scaffolding is in the checkout (`.tools/gold.json`, `gold.sh`). A run that reads it can call the gold record forged; one
  Claude run did. Count those runs separately rather than as a Sphica failure, until the gold slot delivers without readable scaffolding
- A hook tested from a shell inside Claude Code inherits `CLAUDE_CODE_ENTRYPOINT` and `SPHICA_PARENT_SESSION`; unset both, or owner-turn checks
  drop the call and the hook prints nothing
- One run per condition is too weak to credit a difference to Sphica. Run at least two, and say how many in the report
- Before leaving a wait loop in the background, run its exit condition once by hand; a wrong `until` condition kept one polling for 45 minutes
