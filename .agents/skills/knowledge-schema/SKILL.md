---
name: knowledge-schema
description: Changes Sphica's DB schema (db/schema.sql, SQLite), the record model (sources, units and their evidence, adoption, links, states, anchors, aliases), connection roles and authorizers, the full-text search index (FTS5), and how capture and the record server write. Use when touching tables, columns, CHECKs, views, triggers, permissions, search, or a new ingestion path.
---

# Change the knowledge schema

## Triggers

- Changing tables, columns, CHECKs, indexes, views, or triggers in `db/schema.sql`
- Changing connection roles (the authorizers in `server/src/sqlite.ts` and `server/src/db-write.ts`)
- Changing the full-text search index (FTS5, `sphica_terms`, `terms()` / `queryTerms()` in `server/src/text.ts`, `server/src/search.ts`)
- Changing the vocabulary in `server/src/knowledge.ts` (unit kinds, stances, lifecycles, option outcomes, evidence roles, source kinds)
- Adding an ingestion source, or changing how capture, trace, harvest, or glean write

## Does not trigger

- Work that only creates a DB
- Changing only the text of a Skill or of MCP replies (`plugin-release`)

## Source of truth and versions

The DB is a single `node:sqlite` file (`~/.sphica/sphica.db`). The only source of truth is `db/schema.sql`. Do not add an ORM schema as a
second source (Drizzle was rejected: it cannot express FTS5 virtual tables and triggers). `sphica init` applies schema.sql to a temporary file and renames it.

Two numbers version it:

- **Generation** (`sphica_generation`, `SCHEMA_GENERATION` in `server/src/sqlite.ts`): the record model. 0.5.0 is generation 2. A database of
  another generation is refused **without being changed**; the owner moves it aside and runs `sphica init` (0.4 records are not carried over)
- **Revision** (`pragma user_version` at the end of schema.sql, `SCHEMA_REVISION`): changes within a generation. Keep the two equal; the reader and
  ingest connections stop on a mismatch. Capture checks only the generation, so recording keeps working between a DB change and a plugin update

**A revision change ships with a migration.** `db/migrations/<revision>.sql` (4 digits, `0002.sql` moves 1 → 2) holds the same statements as
schema.sql's new state; `sphica init` runs each in one transaction with foreign keys off and checks `foreign_key_check` before committing
(`migrate()` in `server/src/admin.ts`). Rebuilding a table that other triggers name needs those triggers dropped first, or the rename fails.
`server/test/migrate.test.ts` compares a migrated DB with a fresh one; keep the previous revision's schema in `server/test/fixtures/`.
Keep the capture views' columns unchanged across a revision, since capture writes across the change

Rows the new revision refuses are handled in three ways, and none is left to fail the rebuild:

- **Repaired**: take the nearest value the new rules accept, or the row goes when it is derived (a duplicate, an observation). Write each into the temp table
  `sphica_migration_note (rule, item, action)`; `migrate()` prints every row after the step commits. A lifecycle repair adds a state from a run with origin
  `migration` (target `revision:<n>`) and sets `unit.lifecycle` and `revision` by hand, since the triggers are dropped during the rebuild
- **Stopped**: a row no release wrote, or a source the migration may not remove (only the owner's forget removes sources). `<revision>.check.sql` runs first in
  the same transaction and fills `sphica_migration_stop (rule, item)`; any row stops the step with every row listed and nothing changed
- **Rebuilt tables** lose their `sqlite_sequence` row: save the counters first and put back the larger of old and copied, before anything inserts into the table

## When changing the schema

1. Regenerate `server/src/db-types.ts` with `bun run codegen`. **Do not edit it by hand.** CI's `codegen:check` fails on drift
2. Make every table `strict`, and write `not null` on every primary key
3. Give time columns `check (strftime('%Y-%m-%dT%H:%M:%fZ', column) is column)` (with `=`, an invalid string passes as NULL). Writers use `iso()` in `server/src/db.ts`
4. Enforce cross-table consistency (same project, spans inside the source) with triggers, not only in code; `server/test/schema.test.ts` tries each refusal on a real DB
5. A value set lives in a CHECK and in `server/src/knowledge.ts`; `scripts/check-pairs.mjs` compares them. Add a pair there when you add a set
6. Lead every foreign key with an index on its own columns (`schema.test.ts` checks it). A row goes with what it belongs to or with a source it cites
   (cascade); a column naming where a row came from (`run_id`, `forget_id`, `edit_observation_id`) takes no action
7. Keep one path rule: `source.path`, `edit_observation.path`, and `unit_anchor.path` share one CHECK expression (`bun run pairs` compares them)

## The record model

Four boundaries (the header of schema.sql):

| Boundary | Tables | Rule |
|---|---|---|
| Captured sources | `session`, `source`, `artifact_link`, `edit_observation` | Never rewritten. A changed external item (an edited PR body) is a new `revision` |
| Units | `unit` and its `unit_option`, `unit_evidence`, `unit_adoption`, `unit_link`, `unit_state`, `unit_anchor`, `unit_alias` | Text never rewritten; corrections are successors (`supersedes`), retractions, and anchor replacements |
| Processing | `extraction_run`, `source_processing` | What each run looked at, so untraced sessions are counted, not guessed |
| Work and delivery | `work`, `delivery`, `delivery_unit` | Current work, and what the hooks showed (unit ids, never text) |

- **Lifecycle changes only through `unit_state`**, along a fixed table: the first state is candidate; candidate → active, superseded, or withdrawn;
  active → candidate, superseded, or withdrawn; superseded → candidate only when no live successor is left; withdrawn is final. Its trigger sets `unit.lifecycle`.
  Code attempts the move and reports the trigger's refusal
- **Support is one view**, `unit_support`: a decision or constraint needs unit-level unretracted evidence and adoption; an implementation needs code or commit
  evidence (or an `evidence` anchor on a path its session edited); a finding, dead end, or question needs unit-level evidence. Activating, retracting, and
  retiring an anchor all read it, so they never disagree. Quarantined and unsourced units never become active
- **One live successor**: a record has at most one successor that is supported, sourced, and not withdrawn. Withdrawing it brings the record back to candidate
- **Evidence is a byte span of retained text** (`span_start`, `span_end` into the UTF-8 bytes of `source.text`). Quotes are located by the save path, never trusted
- **Adoption** routes: `owner_statement` (an owner-kind source) or `explicit` (the owner, or OWNER / MEMBER / COLLABORATOR). A merge or a resolved thread never adopts
- **Aliases** are search words bound to the unit's `content_hash`; only the newest matching set is indexed. They are never evidence
- **Anchors** hold a path, symbol, and the lines where the symbol was when saved. They are checked against the working tree when read (`server/src/anchors.ts`), never cached
- **Runs bind writes.** `extraction_run.draft_id` is the run id the record server's begin tools issue; check and save take it, and the record never names a project or target

## Writers

| Writer | Connection | Path |
|---|---|---|
| Capture hooks | capture | `server/src/capture.ts`: `capture_session`, `capture_message`, `capture_edit` views |
| Delivery hooks | reader, then capture | `server/src/deliver.ts`: reads units, logs through the `capture_delivery` view |
| Record MCP server | ingest | `server/src/mcp-record.ts` → `extract.ts` → `record.ts` (units), `glean.ts` (changes), `github.ts` (sources) |
| `sphica init` | owner, then ingest | `server/src/admin.ts` creates the DB; `cli.ts` registers the project |
| `sphica doctor --reindex` | owner | `reindex()` in `admin.ts` |
| `sphica init` on an older revision | owner | `migrate()` in `admin.ts` |
| `/sphica:forget` | forget | the record server's `forget_apply` → `forget.ts`, only after the owner confirms |

A new ingestion source writes through the record server's run-bound tools or capture, never a bulk import.

## Connection roles

Processes of the same OS user can rewrite the file directly, so this is not an OS boundary. It guards the path where Sphica's code writes by mistake.

| Role | Authorizer | Used by |
|---|---|---|
| owner | none | creating the DB, reindex, the database check in `doctor` |
| reader | reads and allowed functions (`READER_FUNCTIONS`) only | the read MCP server (`mcp.ts`), delivery reads, `doctor`'s project list |
| ingest | writes only what the record server's code writes: listed tables, listed update columns, deletes of `artifact_link`, and inside triggers only what `INGEST_TRIGGER_WRITES` lists (a test compares it with every trigger body). Sources go through the view `ingest_source`, which cannot take a session message | the record MCP server, project registration |
| forget | inserts into `forget_batch`, `source_forgotten`, `unit_state`; deletes sources and what cites them; `secure_delete` and `wal_checkpoint` pragmas. Ingest may do none of the forget-only writes | `forget_apply` in the record server |
| capture | inserts into the capture views only; reads only `project`'s id, key, and name, `session`'s id, and `source`'s id, session, external id, and kind; functions only inside the views' triggers (`TRIGGER_FUNCTIONS`) | capture and delivery logging |

- Write connections live only in `server/src/db-write.ts`; `bun run architecture` checks the read MCP server cannot reach them
- Enable `enableDefensive(true)` on every connection (it stops direct writes to FTS5 shadow tables)
- Initialization order is fixed: open → defensive and pragmas → `sphica_terms` → authorizer
- Before adding a function to `READER_FUNCTIONS` because a read fails with `not authorized`, see whether the code can compute it instead (the read-delivery budget sums `chars` in JS rather than widening the reader)
- **Do not count rows by affected rows through a view** (an insert into a view reports 0). Count by what exists before and after
- Judge permissions by running them: `server/test/db.test.ts` tries each role's allowed and forbidden operations on real connections.
  A trigger function the authorizer denies fails only at run time (the delivery log once failed this way unnoticed)

## How to write SQL

Write queries with kysely and let it infer types. `openReader()` returns kysely's `ReadonlyKysely<DB>`, and a function that only reads takes `Reads`
(in `db.ts`), which both the reader and a writer fit and which cannot write. Only `sqlite.ts`, `db-write.ts`, `db.ts`, `admin.ts`, and `kysely-node-sqlite.ts` may use node:sqlite
directly (`bun run sql`). Name a node:sqlite connection `raw`, and keep `raw.prepare(` on one line (the SQL ledger finds call sites by line).

| Shape | How to write it |
|---|---|
| JSON columns | `ParseJSONResultsPlugin` turns only the `JSON_COLUMNS` in `db.ts` back into values. On write, pass `JSON.stringify` output |
| Word search | Join FTS5 as a subquery in a `sql` template (`search.ts`). Build the query with `ftsQuery` |
| Times | ISO 8601 UTC strings to the millisecond. Lexical order is time order |
| Booleans | `integer` 0/1 |
| BLOBs | Come back as Buffer (the adapter converts); compare hashes with `.equals` |
| Transactions | `inTransaction` in `db.ts` (`begin immediate`). Do not run queries in parallel inside one |

## Full-text search

`unit_fts` (columns `body`, `ident`, `alias`; filled from the view `unit_search_text`) and `source_fts` (owner words and third-party text; assistant replies are not indexed).
Both are contentless and filled by triggers calling `sphica_terms`, which is `terms()` in `server/src/text.ts`.

- `terms()` splits with Intl.Segmenter, drops hiragana-only words and English stop words, keeps identifiers whole, keeps a kanji word's kanji
  (conjugations meet), and makes English plurals singular. **The index and queries go through the same function**
- **Changing `terms()` leaves existing indexes old.** Raise the revision and end its migration with the statements `reindex()` in `admin.ts` runs,
  so `sphica init` rebuilds both indexes. `server/test/terms-golden.test.ts` pins the output for fixed inputs in `server/src/terms-golden.json`; it cannot stop only its expected values being updated. The file ships, and `sphica doctor` checks the running Node splits the same inputs the same way (an ICU difference)
- `queryTerms()` drops question framing (why, which, and their Japanese counterparts) from queries only. Search keeps a candidate only when it holds **more than half** of the
  question's content terms, and reports how many weaker matches it left out, so a question with no answer returns nothing
- Always quote query terms (`ftsQuery`); unquoted, `AND`, `NEAR`, `:`, and `-` become operators

## Verification

- Tests run SQL on a real SQLite database in a temporary directory (`server/test/temp-db.ts`). Do not touch `~/.sphica`
- `bun run verify` includes `sql:reach` (tests ran every SQL call site in `server/src`, except `LIVE_FILES`), `sql:live` (the CLI and capture as child
  processes), and the acceptance cases
- **The acceptance cases are the contract.** `server/evals/acceptance/cases.json` holds the bilingual cases over capture, status, retrieval, injection,
  review, and glean (`server/test/acceptance-cases.test.ts` fixes the count per layer); `run.ts` plays them through `driver.ts`. For a new behavior, add a case first and confirm it fails for the intended reason
