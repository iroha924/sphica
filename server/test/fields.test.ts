// The fields table against real SQLite: one row per definition with how many records carry a value, and cells that cannot break the table.
import assert from "node:assert/strict";
import { test } from "node:test";
import { fieldsTable } from "../src/fields.ts";
import { sha256 } from "../src/text.ts";
import { at, insert, message, project, run, tempDb } from "./temp-db.ts";

const now = at("2026-09-29T00:00:00Z");

test("the table lists each field with its values, kinds, record count, and the owner's words, and escapes what could break it", async () => {
  const db = tempDb();
  try {
    const p = project(db);
    const other = project(db, "git:github.com/o/other", "o/other");
    assert.match(await fieldsTable(db.reader, p), /No fields are defined in this project/);
    const said = message(db, p, { id: "m1", text: "Track the tenant | and severity\nplease." });
    const r = run(db, p);
    const define = (name: string, v: Record<string, string | null>) =>
      insert(db, "field_def", {
        project_id: p,
        name,
        type: "text",
        label: name,
        description: name,
        source_id: said,
        span_start: 0,
        span_end: 25,
        run_id: r,
        added_at: now,
        ...v,
      });
    const tenant = define("tenant", {
      label: "Tenant | who",
      description: `line one\nline two ${"x".repeat(300)}`,
    });
    define("severity", { type: "enum", enum_values: '["low", "high"]', kinds: '["finding"]' });
    for (const key of ["u1", "u2"]) {
      const u = insert(db, "unit", {
        project_id: p,
        key,
        kind: "decision",
        stance: "do",
        text: key,
        extraction: "supported",
        run_id: r,
        created_at: now,
        content_hash: sha256(key),
      });
      insert(db, "unit_field", {
        unit_id: u,
        field_def_id: tenant,
        value: "acme",
        source_id: said,
        span_start: 0,
        span_end: 5,
        run_id: r,
        added_at: now,
      });
    }
    const table = await fieldsTable(db.reader, p);
    const lines = table.split("\n");
    assert.equal(lines.length, 4, table);
    assert.equal(
      lines[0],
      "| Name | Type | Label | Description | Values | Applies to | Records with a value | Defined by the owner |",
    );
    // Every row keeps exactly the header's columns: an escaped pipe does not open a cell
    for (const l of lines) assert.equal(l.split(/(?<!\\)\|/).length, 10, l);
    assert.match(
      lines[2] ?? "",
      /^\| tenant \| text \| Tenant \\\| who \| line one line two x+ \| {2}\| every kind \| 2 \| s\d+, [^|]*: "Track the tenant \\\| and se" \|$/,
    );
    assert.ok((lines[2]?.split(" | ")[3] ?? "").length <= 200);
    assert.match(
      lines[3] ?? "",
      /^\| severity \| enum \| severity \| severity \| low, high \| finding \| 0 \|/,
    );
    assert.match(await fieldsTable(db.reader, other), /No fields are defined/);
  } finally {
    await db.done();
  }
});
