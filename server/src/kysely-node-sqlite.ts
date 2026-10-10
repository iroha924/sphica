// Copyright (c) 2026 iroha924 and contributors
// SPDX-License-Identifier: MIT

// kysely's SqliteDialect expects the better-sqlite3 shape, and there is no official `node:sqlite` dialect (0.29.6). A thin wrapper adapts it.
// Rows come back as objects without a prototype, so they become plain objects (assert.deepStrictEqual compares prototypes).
// BLOBs come back as Uint8Array. The generated types (db-types.ts) say Buffer, so convert to Buffer (hashes are compared with `.equals`).

import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import type { SqliteDatabase } from "kysely";

const plain = (row: Record<string, unknown>): Record<string, unknown> => {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row))
    out[k] =
      v instanceof Uint8Array && !Buffer.isBuffer(v) ? Buffer.from(v.buffer, v.byteOffset, v.byteLength) : v;
  return out;
};

export function adapt(raw: DatabaseSync): SqliteDatabase {
  return {
    prepare(sqlText: string) {
      const st = raw.prepare(sqlText);
      const args = (p: ReadonlyArray<unknown>) => p as SQLInputValue[];
      return {
        get reader() {
          return st.columns().length > 0;
        },
        all: (p) => st.all(...args(p)).map(plain),
        run: (p) => {
          const r = st.run(...args(p));
          return { changes: r.changes, lastInsertRowid: r.lastInsertRowid };
        },
        iterate: (p) => st.iterate(...args(p)),
      };
    },
    close: () => raw.close(),
  };
}
