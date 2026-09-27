// Builds a real project's fixture database through the same functions the record MCP server runs (harvest, glean), so extraction on real
// pull requests and issues is itself part of the evaluation loop. The agent reads the context this prints and writes the record file.
// Run: node evals/cloud/fixture.ts new <db> <owner/repo>
//      node evals/cloud/fixture.ts harvest <db> <pr>        prints the run id and the context to extract from
//      node evals/cloud/fixture.ts check|save <db> <run> <record.json>
import fs from "node:fs";
import type { Kysely } from "kysely";
import { dbInit } from "../../src/admin.ts";
import type { DB } from "../../src/db-types.ts";
import { openWriter } from "../../src/db-write.ts";
import { beginHarvest, checkText, contextText, saveText } from "../../src/extract.ts";
import { gh } from "../../src/github.ts";

const [command, file = "", ...rest] = process.argv.slice(2);

async function project(db: Kysely<DB>): Promise<{ id: number; repo: string }> {
  const p = await db.selectFrom("project").select(["id", "key"]).executeTakeFirstOrThrow();
  return { id: p.id, repo: p.key.replace(/^git:github\.com\//, "") };
}

async function main() {
  if (command === "new") {
    const repo = rest[0] ?? "";
    if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error("give owner/repo");
    dbInit(file);
    const db = openWriter("ingest", file);
    await db
      .insertInto("project")
      .values({ key: `git:github.com/${repo}`, name: repo })
      .execute();
    await db.destroy();
    return;
  }
  const db = openWriter("ingest", file);
  try {
    const p = await project(db);
    if (command === "harvest") {
      const begun = await beginHarvest(db, p.id, Number(rest[0]), gh(p.repo));
      console.log(`run: ${begun.run}\n${await contextText(db, begun.run, p.id, null)}`);
    } else if (command === "check" || command === "save") {
      const [run = "", recordFile = ""] = rest;
      const record = JSON.parse(fs.readFileSync(recordFile, "utf8")) as unknown;
      console.log(
        command === "check"
          ? (await checkText(db, run, p.id, null, record)).text
          : await saveText(db, run, p.id, null, record),
      );
    } else throw new Error(`unknown command ${command}`);
  } finally {
    await db.destroy();
  }
}

await main();
