// The vocabulary of the record model. The CHECKs in db/schema.sql are the source of truth; this is the copy code uses
// (scripts/check-pairs.mjs compares them).

import { uuidFrom } from "./text.ts";

/** @public Read as text by scripts/check-pairs.mjs. */
export const UNIT_KINDS = [
  "decision",
  "implementation",
  "finding",
  "dead_end",
  "question",
  "constraint",
] as const;

/** @public Read as text by scripts/check-pairs.mjs. */
export const STANCES = ["do", "dont", "defer"] as const;

/** @public Read as text by scripts/check-pairs.mjs. */
export const LIFECYCLES = ["candidate", "active", "superseded", "withdrawn"] as const;

/** @public Read as text by scripts/check-pairs.mjs. */
export const OPTION_OUTCOMES = ["chosen", "rejected", "deferred", "proposed"] as const;

/** @public Read as text by scripts/check-pairs.mjs. */
export const EVIDENCE_ROLES = [
  "states",
  "proposes",
  "rejects",
  "explains",
  "implements",
  "reconsiders",
] as const;

/** @public Read as text by scripts/check-pairs.mjs. */
export const WORK_STATUSES = ["active", "blocked", "paused", "done", "abandoned"] as const;

/** @public Read as text by scripts/check-pairs.mjs. */
export const FIELD_TYPES = ["text", "enum", "integer", "date"] as const;

/** @public Read as text by scripts/check-pairs.mjs. A migration run is written by a migration's SQL, never by a begin tool. */
export const RUN_ORIGINS = ["trace", "harvest", "glean", "migration"] as const;
export type BeginOrigin = Exclude<(typeof RUN_ORIGINS)[number], "migration">;

/** @public Read as text by scripts/check-pairs.mjs. */
export const HOSTS = ["claude-code", "codex"] as const;
export type Host = (typeof HOSTS)[number];

/** @public Read as text by scripts/check-pairs.mjs. */
export const SOURCE_KINDS = [
  "session_message",
  "pr_body",
  "issue_body",
  "pr_comment",
  "issue_comment",
  "review",
  "review_comment",
  "commit_message",
  "pr_event",
  "file_excerpt",
] as const;

/**
 * The session id. trace and capture use the same rule, so whichever writes first creates the same row.
 * A session that moved between projects (to another repository midway) becomes a separate session per project.
 */
export const sessionId = (projectId: number, host: Host, externalId: string): string =>
  uuidFrom(String(projectId), host, externalId);
