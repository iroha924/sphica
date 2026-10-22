# sphica-pane

A Claude Code pane that lists what [Sphica](https://github.com/iroha924/sphica)'s hooks handed the agent in this session: the current work and constraints at session start, the records shown before a read, an edit, or a prompt, and the reason when Sphica stopped a shell call.

Install it beside Sphica from the same marketplace, then run `/sphica-pane`:

```bash
claude plugin install sphica-pane@sphica
```

- Claude Code 2.1.300 or later, the version its checks run on. Older Claude Code fails to load it
- Claude Code only. Codex has no mods, so do not install it in Codex
- Where an organization manages Claude Code, the hooks it reads run only for plugins the organization lists, so the pane stays empty
- It is a mod: it runs with Claude Code's permissions. It only reads the results of the hooks below it, returns them unchanged, and writes nothing, reads no files, and sends nothing anywhere
- It picks Sphica's text by Sphica's wording, so text another plugin writes in the same words shows too. Treat the pane as a view, not a record
- It keeps the newest 100 pieces of this session. Close the pane with ctrl+x x
- Remove it with `claude plugin uninstall sphica-pane@sphica`. Sphica itself keeps working
