// The fields table against real SQLite: one row per definition with how many records carry a value, and cells that cannot break the table.
import assert from "node:assert/strict";
import { test } from "node:test";
import { fieldsTable, fieldsText } from "../src/fields.ts";
import { sha256 } from "../src/text.ts";
import { at, insert, message, project, run, tempDb } from "./temp-db.ts";

const now = at("2026-09-29T00:00:00Z");

/** A row's cells as GFM reads them: a pipe splits only when an even run of backslashes (none included) comes before it. */
function cells(line: string): string[] {
  const out = [""];
  let slashes = 0;
  for (const ch of line) {
    if (ch === "|" && slashes % 2 === 0) out.push("");
    else out[out.length - 1] += ch;
    slashes = ch === "\\" ? slashes + 1 : 0;
  }
  return out.slice(1, -1).map((c) => c.trim());
}

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
      label: "Tenant \\| who\\",
      description: `line one\nline two ${"あ".repeat(300)}`,
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
    // Every row keeps exactly the header's columns, whatever backslashes and pipes the text held
    for (const l of lines) assert.equal(cells(l).length, 8, l);
    const row = cells(lines[2] ?? "");
    assert.deepEqual(row.slice(0, 3), ["tenant", "text", "Tenant \\\\\\| who\\\\"]);
    // Cut to 200 characters, not bytes: Japanese keeps as many characters as English
    assert.equal([...(row[3] ?? "")].length, 200);
    assert.match(row[3] ?? "", /^line one line two あ+$/);
    assert.deepEqual(row.slice(4, 7), ["", "every kind", "2"]);
    assert.match(row[7] ?? "", /^s\d+, [^ ]+: "Track the tenant \\\| and se"$/);
    assert.match(
      lines[3] ?? "",
      /^\| severity \| enum \| severity \| severity \| low, high \| finding \| 0 \|/,
    );
    assert.match(await fieldsTable(db.reader, other), /No fields are defined/);
    // The reply wraps the table as past records, so a label cannot pass for an instruction
    const reply = await fieldsText(db.reader, p);
    assert.match(reply, /^<past-records id="[0-9a-f]+">\n/);
    assert.ok(reply.includes(lines[2] ?? "-"));
  } finally {
    await db.done();
  }
});
