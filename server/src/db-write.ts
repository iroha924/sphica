// Writing connections (owner, ingest, capture). **Never imported from MCP or search** (scripts/check-architecture.mjs).
// Connection setup order is fixed: open → defensive and pragmas → the tokenizer function → authorizer.

import { constants as C, DatabaseSync } from "node:sqlite";
import type { Kysely } from "kysely";
import { kyselyOn } from "./db.ts";
import type { DB } from "./db-types.ts";
import { dbFile, prepare, type Role, requireFile, requireRuntime, SHADOW } from "./sqlite.ts";
import { terms } from "./text.ts";

export type WriteRole = Exclude<Role, "reader">;

/**
 * Actions that change the schema. Allowed only for owner. **Built on first use.** Building it at load time would fail first on old Node
 * versions without these names (22, for example), ahead of the `requireRuntime` message, and even `--help` would break.
 */
let ddl: Set<number> | null = null;
const DDL = (): Set<number> =>
  (ddl ??= new Set(
    [
      "SQLITE_ALTER_TABLE",
      "SQLITE_ANALYZE",
      "SQLITE_ATTACH",
      "SQLITE_CREATE_INDEX",
      "SQLITE_CREATE_TABLE",
      "SQLITE_CREATE_TEMP_INDEX",
      "SQLITE_CREATE_TEMP_TABLE",
      "SQLITE_CREATE_TEMP_TRIGGER",
      "SQLITE_CREATE_TEMP_VIEW",
      "SQLITE_CREATE_TRIGGER",
      "SQLITE_CREATE_VIEW",
      "SQLITE_CREATE_VTABLE",
      "SQLITE_DETACH",
      "SQLITE_DROP_INDEX",
      "SQLITE_DROP_TABLE",
      "SQLITE_DROP_TEMP_INDEX",
      "SQLITE_DROP_TEMP_TABLE",
      "SQLITE_DROP_TEMP_TRIGGER",
      "SQLITE_DROP_TEMP_VIEW",
      "SQLITE_DROP_TRIGGER",
      "SQLITE_DROP_VIEW",
      "SQLITE_DROP_VTABLE",
      "SQLITE_REINDEX",
    ].map((name) => {
      const code = (C as Record<string, number | undefined>)[name];
      // A misspelled name becomes undefined, and that operation would be silently allowed.
      if (code === undefined) throw new Error(`node:sqlite constants has no ${name}`);
      return code;
    }),
  ));

/** FTS5 checks data_version whenever it touches the index. Only the pragma with no value is allowed. */
const readsDataVersion = (p1: string | null, p2: string | null) => p1 === "data_version" && p2 === null;

/** Views capture may insert into. Their triggers derive project, artifact, and indexing from the session (db/schema.sql). */
const CAPTURE_VIEWS = new Set(["capture_session", "capture_message", "capture_edit", "capture_delivery"]);

/** Tables that may be written inside triggers, keyed by trigger name (the authorizer's 5th argument). */
const TRIGGER_WRITES: Record<string, Set<string>> = {
  capture_session_insert: new Set(["session"]),
  capture_message_insert: new Set(["source"]),
  capture_edit_insert: new Set(["edit_observation"]),
  capture_delivery_insert: new Set(["delivery", "delivery_unit"]),
  source_fts_ai: new Set(["source_fts"]),
};

/** Functions a capture view's trigger may call (the delivery log fills defaults and expands its unit list); capture's own statements may not. */
const TRIGGER_FUNCTIONS: Record<string, Set<string>> = {
  capture_delivery_insert: new Set(["coalesce", "json_each", "last_insert_rowid"]),
};

/**
 * Columns capture may read directly: the project mapping, and whether messages to send already exist (for counting). **It cannot read bodies.**
 * Reads inside triggers (foreign key and unique checks) are allowed separately.
 */
const CAPTURE_READS: Record<string, Set<string>> = {
  project: new Set(["id", "key", "name"]),
  session: new Set(["id"]),
  source: new Set(["id", "session_id", "external_id", "kind"]),
};

/**
 * `own` is true only while this connection prepares a statement it built. FTS5 prepares statements that read and write its internal
 * tables (SHADOW) during execution, so only those pass. **Internal tables hold index terms as is**, so built statements never read them.
 */
function captureAuthorizer(
  own: boolean,
  action: number,
  p1: string | null,
  p2: string | null,
  triggerOrView: string | null,
): number {
  const table = p1 ?? "";
  // _config (FTS5 settings such as its version; no terms) is read while a new connection prepares to open the virtual table.
  const fts = SHADOW.test(table) && (!own || (action === C.SQLITE_READ && table.endsWith("_config")));
  if (action === C.SQLITE_INSERT) {
    if (CAPTURE_VIEWS.has(table)) return C.SQLITE_OK;
    if (triggerOrView !== null && TRIGGER_WRITES[triggerOrView]?.has(table)) return C.SQLITE_OK;
    return fts ? C.SQLITE_OK : C.SQLITE_DENY;
  }
  if (action === C.SQLITE_UPDATE || action === C.SQLITE_DELETE) return fts ? C.SQLITE_OK : C.SQLITE_DENY;
  if (action === C.SQLITE_READ) {
    if (triggerOrView !== null || fts) return C.SQLITE_OK;
    return CAPTURE_READS[table]?.has(p2 ?? "") ? C.SQLITE_OK : C.SQLITE_DENY;
  }
  if (action === C.SQLITE_FUNCTION)
    return p2 === "sphica_terms" ||
      (triggerOrView !== null && TRIGGER_FUNCTIONS[triggerOrView]?.has(p2 ?? ""))
      ? C.SQLITE_OK
      : C.SQLITE_DENY;
  if (action === C.SQLITE_PRAGMA) return readsDataVersion(p1, p2) ? C.SQLITE_OK : C.SQLITE_DENY;
  if (action === C.SQLITE_SELECT || action === C.SQLITE_TRANSACTION || action === C.SQLITE_SAVEPOINT)
    return C.SQLITE_OK;
  return C.SQLITE_DENY;
}

function ingestAuthorizer(action: number, p1: string | null, p2: string | null): number {
  if (DDL().has(action)) return C.SQLITE_DENY;
  if (action === C.SQLITE_PRAGMA) return readsDataVersion(p1, p2) ? C.SQLITE_OK : C.SQLITE_DENY;
  return C.SQLITE_OK;
}

/**
 * Opens a writing connection. Only owner's `sphica init` passes `create` (a missing database is never created silently).
 * **The tokenizer function is always registered.** A connection without it writing to knowledge / message would fail the FTS trigger
 * with no such function (the index is never silently incomplete; fail-closed).
 */
export function connectWriter(role: WriteRole, file: string = dbFile(), create = false): DatabaseSync {
  requireRuntime();
  if (!create) requireFile(file);
  const raw = new DatabaseSync(file);
  try {
    // Every role refuses another generation. Only ingest checks the revision: owner handles revisions, and capture keeps writing
    // across a revision change within a generation (rejected rows go to rejected/).
    prepare(raw, create ? "none" : role === "ingest" ? "revision" : "generation");
    raw.function("sphica_terms", { deterministic: true }, (text) => terms(String(text ?? "")).join(" "));
  } catch (e) {
    raw.close();
    throw e;
  }
  if (role === "ingest") raw.setAuthorizer(ingestAuthorizer);
  else if (role === "capture") {
    let own = false;
    raw.setAuthorizer((action, p1, p2, _db, triggerOrView) =>
      captureAuthorizer(own, action, p1, p2, triggerOrView),
    );
    // exec cannot separate prepare from execution, so own stays true while it runs (FTS5's internal reads are rejected too). capture does not use exec.
    const prepare = raw.prepare.bind(raw);
    const exec = raw.exec.bind(raw);
    const mark =
      <A extends unknown[], R>(f: (...a: A) => R) =>
      (...a: A): R => {
        own = true;
        try {
          return f(...a);
        } finally {
          own = false;
        }
      };
    raw.prepare = mark(prepare);
    raw.exec = mark(exec);
  }
  return raw;
}

/** kysely around a writing connection. The connection opens on the first query (kyselyOn in db.ts). */
export function openWriter(role: WriteRole, file: string = dbFile()): Kysely<DB> {
  return kyselyOn(() => connectWriter(role, file));
}
