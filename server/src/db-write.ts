// Writing connections (owner, ingest, capture, forget). **Never imported from MCP or search** (scripts/check-architecture.mjs).
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
const CAPTURE_VIEWS = new Set([
  "capture_session",
  "capture_message",
  "capture_edit",
  "capture_tool_call",
  "capture_delivery",
  "capture_delivery_scoped",
  "capture_delivery_prune",
]);

/** Tables that may be written inside triggers, keyed by trigger name (the authorizer's 5th argument). */
const TRIGGER_WRITES: Record<string, Set<string>> = {
  capture_session_insert: new Set(["session"]),
  capture_message_insert: new Set(["source"]),
  capture_edit_insert: new Set(["edit_observation"]),
  capture_tool_call_insert: new Set(["tool_call_observation"]),
  capture_delivery_insert: new Set(["delivery", "delivery_unit"]),
  capture_delivery_scoped_insert: new Set(["delivery", "delivery_unit"]),
  source_fts_ai: new Set(["source_fts"]),
};

/** Tables capture may delete from, only inside these triggers: pruning old deliveries, and a delivery's units going with it. */
const TRIGGER_DELETES: Record<string, Set<string>> = {
  capture_delivery_prune_insert: new Set(["delivery"]),
  delivery_ad: new Set(["delivery_unit"]),
};

/** Functions a capture view's trigger may call (the delivery log fills defaults and expands its unit list); capture's own statements may not. */
const TRIGGER_FUNCTIONS: Record<string, Set<string>> = {
  capture_delivery_insert: new Set(["coalesce", "json_each", "last_insert_rowid"]),
  capture_delivery_scoped_insert: new Set(["coalesce", "json_each", "last_insert_rowid"]),
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
  if (action === C.SQLITE_DELETE && triggerOrView !== null && TRIGGER_DELETES[triggerOrView]?.has(table))
    return C.SQLITE_OK;
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

/** Whether an action writes a row */
const writes = (action: number) =>
  action === C.SQLITE_INSERT || action === C.SQLITE_UPDATE || action === C.SQLITE_DELETE;

/** The statements the record server writes itself: its tables, and for an update the columns it sets. Everything else is refused. */
const INGEST_INSERTS = new Set([
  "project",
  "record_call",
  "ingest_source",
  "extraction_run",
  "source_processing",
  "unit",
  "unit_option",
  "unit_evidence",
  "unit_adoption",
  "unit_link",
  "unit_state",
  "unit_anchor",
  "unit_alias",
  "field_def",
  "unit_field",
  "work",
  "artifact_link",
]);
const RETRACTION = [
  "retracted_at",
  "retraction_reason",
  "retraction_source_id",
  "retraction_span_start",
  "retraction_span_end",
];
const INGEST_UPDATES: Record<string, Set<string>> = {
  extraction_run: new Set(["status", "finished_at"]),
  unit_anchor: new Set(["retired_at", "replaced_by"]),
  unit_link: new Set(["resolved_at", "resolution"]),
  unit_evidence: new Set(RETRACTION),
  unit_adoption: new Set(RETRACTION),
  // The upsert of the current work
  work: new Set(["title", "goal", "current", "next", "status", "branch", "run_id", "updated_at"]),
};
/** Pull request links follow the current body, so an issue it no longer closes is unlinked */
const INGEST_DELETES = new Set(["artifact_link"]);

/**
 * What each trigger that an ingest write can fire may write, as `<insert|update|delete> <table>`. server/test/db.test.ts compares it
 * with the trigger bodies in the schema, so a trigger added there without an entry here fails the test, not a save.
 * @public Read by server/test/db.test.ts.
 */
export const INGEST_TRIGGER_WRITES: Record<string, string[]> = {
  ingest_source_insert: ["insert source"],
  source_fts_ai: ["insert source_fts"],
  source_fts_ad: ["delete source_fts"],
  unit_state_apply: ["update unit"],
  unit_state_restore: ["insert unit_state"],
  delivery_ad: ["delete delivery_unit"],
  ...Object.fromEntries(
    [
      "evidence_i",
      "evidence_u",
      "evidence_d",
      "adoption_i",
      "adoption_u",
      "adoption_d",
      "link_i",
      "link_u",
      "anchor_i",
      "anchor_u",
      "alias_i",
      "field_i",
      "field_d",
    ].map((t) => [`unit_rev_${t}`, ["update unit"]]),
  ),
  unit_fts_ai: ["insert unit_fts"],
  unit_fts_ad: ["delete unit_fts"],
  ...Object.fromEntries(
    ["option_i", "anchor_i", "anchor_u", "anchor_d", "alias_i", "alias_d", "field_i", "field_d"].map((t) => [
      `unit_fts_${t}`,
      ["delete unit_fts", "insert unit_fts"],
    ]),
  ),
};

const opOf = (action: number): "insert" | "update" | "delete" | undefined =>
  action === C.SQLITE_INSERT
    ? "insert"
    : action === C.SQLITE_UPDATE
      ? "update"
      : action === C.SQLITE_DELETE
        ? "delete"
        : undefined;

/**
 * The record server reads text anyone wrote, so its connection writes only what its own code writes: the owner identity, a session's
 * messages, the full-text indexes' commands, and the schema generation are out of its reach, and it deletes nothing but stale links.
 * REPLACE's implicit delete never reaches the authorizer; scripts/check-sql.mjs keeps it out of the code instead.
 */
function ingestAuthorizer(
  action: number,
  p1: string | null,
  p2: string | null,
  trigger: string | null,
): number {
  if (DDL().has(action)) return C.SQLITE_DENY;
  const op = opOf(action);
  if (op) {
    const table = p1 ?? "";
    // FTS5 writes its own tables while it runs; defensive mode refuses a statement that names them
    if (SHADOW.test(table)) return C.SQLITE_OK;
    if (trigger !== null)
      return INGEST_TRIGGER_WRITES[trigger]?.includes(`${op} ${table}`) ? C.SQLITE_OK : C.SQLITE_DENY;
    const allowed =
      op === "insert"
        ? INGEST_INSERTS.has(table)
        : op === "update"
          ? INGEST_UPDATES[table]?.has(p2 ?? "")
          : INGEST_DELETES.has(table);
    return allowed ? C.SQLITE_OK : C.SQLITE_DENY;
  }
  if (action === C.SQLITE_PRAGMA) return readsDataVersion(p1, p2) ? C.SQLITE_OK : C.SQLITE_DENY;
  if (
    action === C.SQLITE_READ ||
    action === C.SQLITE_SELECT ||
    action === C.SQLITE_FUNCTION ||
    action === C.SQLITE_RECURSIVE ||
    action === C.SQLITE_TRANSACTION ||
    action === C.SQLITE_SAVEPOINT
  )
    return C.SQLITE_OK;
  return C.SQLITE_DENY;
}

/**
 * What the forget connection may change: forget.ts runs fixed SQL, and this is the coarse guard around it. Deletes cascade to evidence,
 * adoption, processing, field definition, and field value rows, clear unit_state.source_id, raise unit revisions, and reindex units that
 * lose a field value; the authorizer sees those as plain writes.
 */
const FORGET_WRITES: Record<number, Set<string>> = {
  [C.SQLITE_INSERT]: new Set(["forget_batch", "source_forgotten", "unit_state", "source_fts", "unit_fts"]),
  [C.SQLITE_DELETE]: new Set([
    "source",
    "unit_evidence",
    "unit_adoption",
    "source_processing",
    "source_fts",
    "field_def",
    "unit_field",
    "unit_fts",
  ]),
};
/** Columns forget changes: the state and revision triggers set on unit, and the foreign key action clearing unit_state.source_id. */
const FORGET_UPDATES: Record<string, Set<string>> = {
  unit: new Set(["lifecycle", "revision"]),
  unit_state: new Set(["source_id"]),
};

function forgetAuthorizer(action: number, p1: string | null, p2: string | null): number {
  if (SHADOW.test(p1 ?? "") && writes(action)) return C.SQLITE_OK;
  if (action === C.SQLITE_UPDATE)
    return FORGET_UPDATES[p1 ?? ""]?.has(p2 ?? "") ? C.SQLITE_OK : C.SQLITE_DENY;
  if (action === C.SQLITE_INSERT || action === C.SQLITE_DELETE)
    return FORGET_WRITES[action]?.has(p1 ?? "") ? C.SQLITE_OK : C.SQLITE_DENY;
  // secure_delete may only be turned on: the deleted text must not stay in freed pages
  if (action === C.SQLITE_PRAGMA)
    return readsDataVersion(p1, p2) ||
      (p1 === "secure_delete" && ["on", "1", "true"].includes((p2 ?? "").toLowerCase())) ||
      p1 === "wal_checkpoint"
      ? C.SQLITE_OK
      : C.SQLITE_DENY;
  // Recursive reads: judging records again walks supersedes chains (unit_successor_place, unit_state_restore)
  if (
    action === C.SQLITE_READ ||
    action === C.SQLITE_SELECT ||
    action === C.SQLITE_RECURSIVE ||
    action === C.SQLITE_FUNCTION ||
    action === C.SQLITE_TRANSACTION ||
    action === C.SQLITE_SAVEPOINT
  )
    return C.SQLITE_OK;
  return C.SQLITE_DENY;
}

/**
 * Opens a writing connection. Only owner's `sphica init` passes `create` (a missing database is never created silently).
 * **The tokenizer function is always registered.** A connection without it writing to knowledge / message would fail the FTS trigger
 * with no such function (the index is never silently incomplete; fail-closed).
 */
export function connectWriter(
  role: WriteRole,
  file: string = dbFile(),
  create = false,
  busyMs?: number,
): DatabaseSync {
  requireRuntime();
  if (!create) requireFile(file);
  const raw = new DatabaseSync(file);
  try {
    // Every role refuses another generation. Ingest and forget check the revision: owner handles revisions, and capture keeps writing
    // across a revision change within a generation (rejected rows go to rejected/).
    prepare(
      raw,
      create ? "none" : role === "ingest" || role === "forget" ? "revision" : "generation",
      busyMs,
    );
    raw.function("sphica_terms", { deterministic: true }, (text) => terms(String(text ?? "")).join(" "));
  } catch (e) {
    raw.close();
    throw e;
  }
  if (role === "ingest")
    raw.setAuthorizer((action, p1, p2, _db, trigger) => ingestAuthorizer(action, p1, p2, trigger));
  else if (role === "forget") raw.setAuthorizer(forgetAuthorizer);
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

/** kysely around a writing connection. The connection opens on the first query (kyselyOn in db.ts). busyMs shortens the lock wait. */
export function openWriter(role: WriteRole, file: string = dbFile(), busyMs?: number): Kysely<DB> {
  return kyselyOn(() => connectWriter(role, file, false, busyMs));
}
