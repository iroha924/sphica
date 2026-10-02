---
name: codex-review
description: Asks Codex (codex exec) to review or investigate a Sphica diff. Use before merging a PR, when checking a decision that primary sources cannot settle against another model, and when looking back at a change that landed. Covers receiving Codex's findings and fixing them. Not for launching Claude Code's reviewer (review-shipping).
---

# Ask Codex for reviews and investigations

## Triggers

- Before merging a PR (an independent review of the diff)
- When primary sources cannot settle a decision, or rules conflict
- When looking back at a change that landed on main

## Does not trigger

- Launching Claude Code's reviewer (`review-shipping`)
- Handing implementation to Codex

## How to ask

```bash
codex exec -s read-only --ignore-rules --ephemeral -c model_reasoning_effort="high" - < <request file> > <output file> 2>&1
```

- Launch it with Bash's `run_in_background` and wait for the completion notice. One run takes 10 to 15 minutes. Do not stop it midway
- Do not pass a model (the owner's `~/.codex/config.toml` decides). Pass effort `high` for the review before merging a PR and for a decision primary sources cannot settle; a re-review of a small fix and a look back at a landed change leave it out (the config's `medium`). Without `model_reasoning_effort` in the config, Codex runs the model's own default, which is `low` for gpt-6.1-sol
- Pass `--ignore-rules`: commands the owner always allowed in `~/.codex/rules` otherwise run outside the read-only sandbox
- Write the request in the scratchpad, and include:
  - Scope: `git diff <base>..<head>`, or the uncommitted `git diff` and its base commit
  - What the change does, and what the owner decided (not open to findings)
  - Acceptance criteria
  - The shape of the answer: heaviest first, `file:line`, an input that reproduces it, certainty (reproduced / read and confirmed / inference). If there are no defects, say so
  - Read only; do not modify files
- Do not pass the conclusions of Claude's reviewers or your own view (the judgment would stop being independent)

## How to receive it

- The final answer appears again after `tokens used` in the output. Read it there
- Treat findings as claims. Confirm them in the code or by reproducing them, and write a test that fails on the unfixed code before fixing
- After fixing, send only the fix's diff out for re-review
- Write Codex's review result (the number of findings and how each was handled) in the PR body's "Verification" section. Without it, CI (`pr-body`) fails
- For findings you did not take, write the reason, one line each, in the PR body's "Declined findings" section
- Stop when findings narrow to edge inputs and nothing violates the acceptance criteria
