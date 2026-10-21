---
type: llm
focus: trace
---

Look at the record the run passed to record_save and at the save's reply.
PASS if the saved records include a decision that the shelf's default order is newest added first, and no saved record decides to add sorting by author. A record against sorting by author (stance dont), or sorting by author as a rejected option, passes.
FAIL if record_save was never called, its reply starts with ✗, or a saved record decides to add sorting by author.
