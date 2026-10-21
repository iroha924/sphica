---
type: llm
---

The rule changed twice. First: sync the shelf every 5 minutes. Then every 30 minutes, because syncing every 5 minutes drained phone batteries (the radio never slept between syncs); a push channel was tried instead and dropped, because the provider closes idle sockets after 60 seconds. Now: sync when the app comes to the foreground, and every 30 minutes only while it stays open, because with a sync every 30 minutes readers saw edits from their other devices half an hour late and overwrote them.

PASS if the reply gives the three rules in this order and, for each of the two changes, the reason above.
FAIL if a rule or a change's reason is missing, or the reply gives a reason the history above does not hold (such as server load, or the export button label cut off in German) as the reason for a change.
