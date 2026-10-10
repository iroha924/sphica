# Roadmap

What Sphica intends to do, and not do, over the next twelve months. It is a direction, not a schedule. Most items below are experiments: each is measured before it is adopted, and one that does not help is recorded as not adopted and left out ([#200](https://github.com/iroha924/sphica/issues/200) has the policy).

## Intends to do

**Toward 1.0**

- Keep saved records right: checks that catch a record whose code location, evidence, or state has gone stale ([#209](https://github.com/iroha924/sphica/issues/209)).
- Show records better: how delivered records are presented, ordered, and attributed ([#206](https://github.com/iroha924/sphica/issues/206)), and showing them again after a subagent compacts ([#244](https://github.com/iroha924/sphica/issues/244)).
- Decide on delivery after shell commands: it is an option that is off by default, and stays or goes by how the trial measures ([#219](https://github.com/iroha924/sphica/issues/219)).
- Find the record a reworded request conflicts with ([#260](https://github.com/iroha924/sphica/issues/260)).
- Move the MCP servers to version 2 of the SDK once it is ready upstream ([#279](https://github.com/iroha924/sphica/issues/279)).

**After that, as each proves worth it**

- Search as of a date, and a timeline of how a decision changed ([#217](https://github.com/iroha924/sphica/issues/217)).
- Import sessions from before Sphica was installed ([#215](https://github.com/iroha924/sphica/issues/215)).
- A queue of decisions that wait for your word ([#214](https://github.com/iroha924/sphica/issues/214)).
- Tell you about merged pull requests whose decisions were not yet taken into Sphica ([#221](https://github.com/iroha924/sphica/issues/221)).
- Tie dead ends to the commands that hit them ([#218](https://github.com/iroha924/sphica/issues/218)).

**The project itself**

- Take pull requests from outside contributors, and make the way they are taken in safer against text written to mislead the reviewer.
- Keep working in both Claude Code and Codex, on macOS, Linux, and Windows.
- Reach the silver level of the OpenSSF Best Practices badge.

## Does not intend to do

- **No hosted service, account, or telemetry.** The database stays one SQLite file on your machine, and Sphica runs no server that listens.
- **Nothing that needs an API key or extra billing.** Sphica works with the subscription the agent already runs on.
- **No rewriting of records.** A correction is a new record that replaces the old one, and the history stays.
