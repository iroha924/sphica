# Verification

## Release

- For a change that goes into the package, run `bun run release:plan -- --base <previous release commit>` before editing the version, and handle it by the kind it reports <!-- invariant: release-plan -->
  - `none`: no release
  - `plugin`: a change that goes into the package (MCP, CLI, hooks, plugin Skills and Agents, shared modules). Bump npm and the 3 plugin manifests to the same version
- The only thing published to npm is the tarball `.github/workflows/release.yml` publishes from the `v<version>` tag on the PR head, after the owner approves the `npm-release` environment. Do not run `npm publish` locally. The same run merges the PR and creates the GitHub Release; follow the `plugin-release` Skill's steps around it
- Before each release step, reopen the `plugin-release` Skill and run its commands exactly as written. The owner approves the `npm-release` environment, the only gate before npm. Claude does not do it in the owner's place, on the page or through the API <!-- invariant: release-owner-steps -->

## Tests

- Run SQL on a real SQLite database in a temporary directory (`server/test/temp-db.ts`) and look at the results. Do not match built SQL strings (SQL that never runs stays green) <!-- invariant: real-sqlite-tests -->
- Do not touch `~/.sphica`. Pass the DB path as an argument or through `SPHICA_DB`
- `sql:reach` counts whether tests ran each SQL call site in `server/src` (except `LIVE_FILES`, which `sql:live` covers). The ledger is `scripts/lib/sql-call-sites.mjs`
- `sql:live` runs the CLI and the capture hooks as child processes. Set the child's `HOME` to a temporary directory and do not pass the parent's `SPHICA_DB` or `SPHICA_HOME` (otherwise it reads and writes the owner's `~/.sphica`, or the directory `SPHICA_HOME` names) <!-- invariant: temp-home -->
- Do not skip when a precondition is missing. Fail (otherwise it always skips in CI and stays green) <!-- invariant: no-silent-skip -->
- Do not connect to external APIs. Pass without credentials. For GitHub, pass a fake `Get` to `server/src/github.ts`, or put a fake `gh` first on PATH (the acceptance driver does) <!-- invariant: no-external-api -->
- Close connections with `TempDb.done()` (a held connection keeps `verify` from finishing). The source of truth for the time limit is `--test-timeout` in `server/package.json`

## SQLite return values

- BLOBs come back as Uint8Array. `server/src/kysely-node-sqlite.ts` converts them to Buffer <!-- invariant: sqlite-values -->
- Rows come back as objects without a prototype (`assert.deepStrictEqual` compares prototypes too)
- STRICT tables accept values they can convert (`"1"` → 1). To check a rejection, use a value that cannot be converted
- In a table with an `integer primary key`, `returning rowid` comes back under the primary key's name. Write `returning rowid as rowid`
- node:sqlite enables defensive mode by default. To check that something fails without it, use `enableDefensive(false)`

## Package

- `plugin/dist` and `plugin/db` are untracked, so they do not show in `git diff`. Run `npm pack`, unpack it outside the repository, count its contents, and start it <!-- invariant: pack-and-inspect -->
