#!/usr/bin/env node
// Copyright (c) 2026 iroha924 and contributors
// SPDX-License-Identifier: MIT

// Checks an npm pack tarball the way users receive it (run by CI check and release). Usage: node scripts/check-tarball.mjs <tgz>
// It checks the file list, the version, that the CLI starts outside the repository and creates a database in a temp HOME, that the hook names
// the version for an older database that init then backs up and migrates, that the hook delivers quickly under a write lock, and answers SubagentStart

import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { hasBannedName } from "./lib/banned-name.mjs";
import { fail, finding, guard, report } from "./lib/finding.mjs";
import { linksOutside } from "./lib/link-containment.mjs";
import { tarballProblems, trackedDistribution } from "./lib/tarball.mjs";

guard("tarball");

const root = path.resolve(import.meta.dirname, "..");
// Every step runs what users receive, so a failure here is a defect in the package itself
const SHIPPED = "users install exactly this tarball, so what fails here fails for them";
// The packed Markdown is built from these: plugin/README.md is a copy bundle.mjs makes of the root README.md, so edits there are lost
const PACKED_FROM =
  "the file it was packed from (README.md at the repository root for README.md, plugin/<same path> for the rest)";

/** tar's output, or a finding with what tar said */
function tar(args, where) {
  const r = spawnSync("tar", args, { encoding: "utf8" });
  if (r.error || r.status !== 0)
    fail({
      where,
      what: `tar ${args[0]} failed: ${r.error?.message ?? `exit ${r.status}`}`,
      why: "the tarball is checked as users receive it, so it must be a gzipped tar that tar can read",
      fix: "pass the .tgz npm pack wrote, and pack again if it is cut short",
      detail: r.stderr,
    });
  return r.stdout;
}

main();

function main() {
  const tgz = process.argv[2] && path.resolve(process.argv[2]);
  if (!tgz)
    fail({
      where: "node scripts/check-tarball.mjs",
      what: "no tarball path was given",
      why: "the check runs the one tarball it is given",
      fix: "run node scripts/check-tarball.mjs <the .tgz npm pack wrote>",
    });
  const where = path.basename(tgz);
  const listed = tar(["tzf", tgz], where);
  const paths = new Set(
    listed
      .split("\n")
      .filter((f) => f && !f.endsWith("/"))
      .map((f) => f.replace(/^package\//, "")),
  );
  if (
    report(
      "tarball",
      tarballProblems(paths, trackedDistribution(root)).map((p) => finding({ where, ...p })),
    )
  )
    return;

  // **Extract outside the repository.** Inside it, a wrong bundle would still resolve by walking up and pass.
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "sphica-tarball-"));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "sphica-home-"));
  // Do not pass SPHICA_DB or SPHICA_HOME, which point to the owner's database, to the child (only the temp HOME database is created,
  // and the fake gh's account must never be bound in the owner's)
  const parentEnv = { ...process.env };
  delete parentEnv.SPHICA_DB;
  delete parentEnv.SPHICA_HOME;
  // doctor would start the Codex under the parent's CODEX_HOME, which writes there
  delete parentEnv.CODEX_HOME;
  // A runner started from an agent's shell would make the hook take this check for that agent's run and hold back its delivery
  delete parentEnv.SPHICA_PARENT_SESSION;
  delete parentEnv.CODEX_THREAD_ID;
  delete parentEnv.CLAUDE_CODE_ENTRYPOINT;
  // init reads the signed-in account through gh: a fake gh first on PATH answers, so the runner's gh never reaches api.github.com
  const bin = path.join(home, "fake-gh");
  fs.mkdirSync(bin);
  fs.writeFileSync(
    path.join(bin, "gh"),
    `#!${process.execPath}\nconst a = process.argv.slice(2);\nif (a[0] === "api" && a[1] === "user") process.stdout.write('{"id":42,"login":"hana"}');\nelse process.exit(1);\n`,
    { mode: 0o755 },
  );
  parentEnv.PATH = `${bin}${path.delimiter}${process.env.PATH ?? ""}`;
  try {
    tar(["xzf", tgz, "-C", out], where);
    const pkg = path.join(out, "package");
    const cli = (...args) =>
      execFileSync(process.execPath, [path.join(pkg, "dist", "cli.js"), ...args], {
        cwd: out,
        encoding: "utf8",
        env: { ...parentEnv, HOME: home, USERPROFILE: home },
      });
    const version = JSON.parse(fs.readFileSync(path.join(pkg, "package.json"), "utf8")).version;
    const expected = JSON.parse(fs.readFileSync(path.join(root, "plugin", "package.json"), "utf8")).version;
    if (version !== expected)
      fail({
        where,
        what: `the tarball is ${version}, but plugin/package.json is ${expected}`,
        why: "a stale tarball checks something other than what this tree would ship",
        fix: "run `bun run bundle` and npm pack again, then check the new tarball",
      });
    // The packed Markdown, which the repository's own checks do not see as shipped: a link whose target is in the checkout but not in the
    // package passes there. Same rules and offline link check as the repository, with every path given literally.
    const docs = [...paths].filter((f) => f.endsWith(".md")).map((f) => path.join(pkg, f));
    const linted = spawnSync(
      process.execPath,
      [
        path.join(root, "server", "node_modules", "markdownlint-cli2", "markdownlint-cli2-bin.mjs"),
        "--config",
        path.join(root, ".markdownlint-cli2.jsonc"),
        ...docs.map((f) => `:${f}`),
      ],
      { cwd: pkg, encoding: "utf8" },
    );
    // markdownlint-cli2 exits 1 when it linted and found errors, and 2 when it could not lint. Node also exits 1 when the tool cannot
    // start (a missing module), so only its closing summary shows that linting ran
    const found =
      linted.status === 1 && /^Summary: [1-9]\d* issues? in /m.test(`${linted.stdout}${linted.stderr}`);
    if (linted.status !== 0)
      fail({
        where: `${where} (markdownlint-cli2)`,
        what: found
          ? "markdownlint found packed Markdown that renders or links wrong"
          : `markdownlint-cli2 could not lint the packed Markdown (${linted.error?.message ?? `exit ${linted.status}`})`,
        why: "npm and the hosts show the packed Markdown away from the repository",
        fix: found
          ? `fix each line below in ${PACKED_FROM}, then bundle and pack again`
          : "run `bun run setup` to install it, and fix what its output below names",
        detail: `${linted.stdout ?? ""}${linted.stderr ?? ""}`,
      });
    // --verbose (which the containment check needs) also lists every excluded URL on stderr, so it is shown only on failure
    const checked = spawnSync(
      "lychee",
      ["--config", path.join(root, "lychee.toml"), "--format", "json", "--verbose", "--", ...docs],
      { cwd: pkg, encoding: "utf8" },
    );
    // lychee exits 2 on links that failed the check, and 1 or 3 when it could not check
    if (checked.error?.code === "ENOENT")
      fail({
        where: `${where} (lychee)`,
        what: "lychee is not on PATH",
        why: "the packed Markdown's links cannot be checked without it, and a check that did not run must not pass (invariant no-silent-skip)",
        fix: "run `mise install`, which installs the lychee version mise.toml pins",
      });
    if (checked.status !== 0)
      fail({
        where: `${where} (lychee)`,
        what:
          checked.status === 2
            ? "lychee found broken links, images, or anchors in the packed Markdown"
            : `lychee could not check the packed Markdown (${checked.error?.message ?? `exit ${checked.status}`})`,
        why: "a link that holds in the checkout can point at a file the package does not carry",
        fix:
          checked.status === 2
            ? `fix each link below in ${PACKED_FROM}, then bundle and pack again`
            : "fix the input or lychee.toml setting its output below names",
        detail: `${checked.stderr ?? ""}${checked.stdout ?? ""}`,
      });
    const outside = linksOutside(JSON.parse(checked.stdout), pkg);
    if (outside.length)
      report(
        "tarball",
        outside.map((x) =>
          finding({
            where: x.source,
            what: `the packed Markdown links outside the package: ${x.url}`,
            why: "the package is read away from the repository, where a file outside it does not exist",
            fix: `in ${PACKED_FROM}, link to a file the package carries, or to the repository's page on GitHub`,
          }),
        ),
      );
    if (outside.length) return;
    const named = cli("--version").trim().split(/\s+/)[0];
    if (named !== version)
      fail({
        where: "sphica --version (tarball CLI)",
        what: `the CLI reports ${named}, but the package is ${version}`,
        why: "doctor and the hooks compare versions by what the CLI reports",
        fix: "check that the bundle reads its version from plugin/package.json, then bundle and pack again",
      });
    cli("--help");
    cli("doctor", "--help");
    const init = cli("init");
    if (!fs.existsSync(path.join(home, ".sphica", "sphica.db")))
      fail({
        where: "sphica init (tarball CLI)",
        what: "init did not create ~/.sphica/sphica.db",
        why: SHIPPED,
        fix: "run the tarball's dist/cli.js init in a temp HOME and fix what stops it in server/src/cli.ts",
        detail: init,
      });
    if (!/GitHub account hana \(id 42\) bound as the owner/.test(init))
      fail({
        where: "sphica init (tarball CLI)",
        what: "init did not bind the GitHub account gh answered (hana, id 42)",
        why: SHIPPED,
        fix: "check that the bundled init reads gh api user through server/src/github.ts",
        detail: init,
      });
    // doctor can exit 1 on this machine's plugin install state; only its GitHub owner line is checked here
    let doctor;
    try {
      doctor = cli("doctor");
    } catch (e) {
      doctor = `${e.stdout ?? ""}`;
    }
    if (!/✓ GitHub owner\s+hana \(id 42\)/.test(doctor))
      fail({
        where: "sphica doctor (tarball CLI)",
        what: "doctor did not show the bound GitHub account",
        why: SHIPPED,
        fix: "check the GitHub owner row of doctor in server/src/cli.ts against the output below",
        detail: doctor,
      });
    // After a plugin update the database can be a revision behind. The shipped hook names the CLI version to install, and that version's init
    // backs the database up before migrating it
    const behind = fs.mkdtempSync(path.join(os.tmpdir(), "sphica-behind-"));
    try {
      const schemas = path.join(root, "server", "test", "fixtures");
      const older = Math.max(
        ...fs.readdirSync(schemas).map((f) => Number(/^schema-rev(\d+)\.sql$/.exec(f)?.[1] ?? 0)),
      );
      fs.mkdirSync(path.join(behind, ".sphica"));
      const file = path.join(behind, ".sphica", "sphica.db");
      const raw = new DatabaseSync(file);
      raw.exec("pragma journal_mode = wal");
      raw.exec(fs.readFileSync(path.join(schemas, `schema-rev${older}.sql`), "utf8"));
      // Records the shipped migration must carry over: a project, a session, and one message of the owner. The index triggers need the
      // tokenizer to compile; this stand-in is never used for the index, which the migration rebuilds with the real one
      raw.function("sphica_terms", (text) => String(text ?? ""));
      const when = "2026-09-01T00:00:00.000Z";
      raw.exec(
        `insert into project (key, name) values ('git:github.com/example/behind', 'example/behind');
       insert into session (id, project_id, host, external_id, started_at) values ('s1', 1, 'claude-code', 'e1', '${when}');`,
      );
      raw
        .prepare(
          "insert into source (project_id, kind, artifact, external_id, revision, session_id, author_kind, created_at, captured_at, text, original_bytes, content_hash, indexed) values (1, 'session_message', 'session:s1', 'm1', 1, 's1', 'owner', ?, ?, 'Use SQLite.', 11, zeroblob(32), 0)",
        )
        .run(when, when);
      raw.close();
      const repo = path.join(behind, "repo");
      fs.mkdirSync(repo);
      execFileSync("git", ["init", "-q"], { cwd: repo });
      execFileSync("git", ["remote", "add", "origin", "https://github.com/example/behind.git"], {
        cwd: repo,
      });
      const env = { ...parentEnv, HOME: behind, USERPROFILE: behind };
      const said = execFileSync(process.execPath, [path.join(pkg, "dist", "deliver.js")], {
        cwd: repo,
        encoding: "utf8",
        env,
        input: JSON.stringify({
          hook_event_name: "SessionStart",
          session_id: `tarball-${process.pid}-${Date.now()}`,
          cwd: repo,
        }),
      });
      const BEHIND =
        "after a plugin update the database can be a revision behind, and the owner must be told how to bring it up";
      if (!said.includes(`npm i -g sphica@${version}\``))
        fail({
          where: "deliver.js SessionStart (tarball hook)",
          what: `the hook did not name sphica@${version} for a revision ${older} database`,
          why: BEHIND,
          fix: "check that server/src/deliver.ts names the package version when the database is behind",
          detail: said,
        });
      const migrated = execFileSync(process.execPath, [path.join(pkg, "dist", "cli.js"), "init"], {
        cwd: out,
        encoding: "utf8",
        env,
      });
      if (
        !/Backed up: /.test(migrated) ||
        !new RegExp(`Migrated: .*\\(revision ${older} → \\d+\\)`).test(migrated)
      )
        fail({
          where: "sphica init (tarball CLI, older database)",
          what: `init did not back up and migrate a revision ${older} database`,
          why: BEHIND,
          fix: "check the backup in server/src/admin.ts and the migrations in db/migrations/ by the output below",
          detail: migrated,
        });
      const [backup] = fs.readdirSync(path.join(behind, ".sphica", "backups"));
      const copy = new DatabaseSync(path.join(behind, ".sphica", "backups", backup ?? ""), {
        readOnly: true,
      });
      const at = copy.prepare("pragma user_version").get().user_version;
      copy.close();
      if (at !== older)
        fail({
          where: "sphica init (tarball CLI, older database)",
          what: `the backup is at revision ${at}, not ${older}`,
          why: "the backup is the owner's way back if a migration goes wrong, so it must be taken before migrating",
          fix: "take the backup in server/src/admin.ts before the first migration step",
        });
      const after = new DatabaseSync(path.join(behind, ".sphica", "sphica.db"), { readOnly: true });
      const now = after.prepare("pragma user_version").get().user_version;
      const kept = after.prepare("select count(*) as n from source where external_id = 'm1'").get().n;
      after.close();
      if (now <= older || kept !== 1)
        fail({
          where: "sphica init (tarball CLI, older database)",
          what: `the migrated database is at revision ${now} with ${kept} of its 1 message`,
          why: "a migration must carry the owner's records over",
          fix: `check the migrations after revision ${older} in db/migrations/ for what they do to the source table`,
        });
    } finally {
      fs.rmSync(behind, { recursive: true, force: true });
    }
    // The host kills a hook after 5 seconds: the shipped hook must answer quickly, with the record, while another connection holds the
    // write lock. The record is written as the record server would leave it (a saved run, evidence, adoption, candidate then active)
    // The real path, as git reports the root (a macOS temp directory is a link), so the read path is inside it
    const locked = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "sphica-locked-")));
    try {
      const env = { ...parentEnv, HOME: locked, USERPROFILE: locked };
      execFileSync(process.execPath, [path.join(pkg, "dist", "cli.js"), "init"], {
        cwd: out,
        encoding: "utf8",
        env,
      });
      const file = path.join(locked, ".sphica", "sphica.db");
      const raw = new DatabaseSync(file);
      raw.exec("pragma foreign_keys = on");
      raw.function("sphica_terms", (text) => String(text ?? ""));
      const when = new Date().toISOString();
      const said = "Keep one SQLite file.";
      const key = "trace:locked/one-file";
      raw.exec(
        `insert into project (key, name) values ('git:github.com/example/locked', 'example/locked');
       insert into session (id, project_id, host, external_id, started_at) values ('s1', (select id from project where key = 'git:github.com/example/locked'), 'claude-code', 'e1', '${when}');`,
      );
      const pid = raw.prepare("select id from project where key = 'git:github.com/example/locked'").get().id;
      const source = raw
        .prepare(
          "insert into source (project_id, kind, artifact, external_id, revision, session_id, author_kind, created_at, captured_at, text, original_bytes, content_hash, indexed) values (?, 'session_message', 'session:s1', 'm1', 1, 's1', 'owner', ?, ?, ?, ?, zeroblob(32), 0) returning id",
        )
        .get(pid, when, when, said, said.length).id;
      const run = raw
        .prepare(
          "insert into extraction_run (project_id, origin, target, session_id, status, started_at) values (?, 'trace', 'session:s1', 's1', 'running', ?) returning id",
        )
        .get(pid, when).id;
      const unit = raw
        .prepare(
          "insert into unit (project_id, key, kind, stance, text, extraction, run_id, created_at, content_hash) values (?, ?, 'decision', 'do', ?, 'supported', ?, ?, zeroblob(32)) returning id",
        )
        .get(pid, key, said, run, when).id;
      const span = [unit, source, 0, said.length, run, when];
      raw
        .prepare(
          "insert into unit_evidence (unit_id, source_id, span_start, span_end, role, run_id, added_at) values (?, ?, ?, ?, 'states', ?, ?)",
        )
        .run(...span);
      raw
        .prepare(
          "insert into unit_adoption (unit_id, route, source_id, span_start, span_end, run_id, added_at) values (?, 'owner_statement', ?, ?, ?, ?, ?)",
        )
        .run(...span);
      raw
        .prepare(
          "insert into unit_anchor (unit_id, path, role, run_id, added_at) values (?, 'src/db.ts', 'applies_to', ?, ?)",
        )
        .run(unit, run, when);
      for (const [from, to] of [
        [null, "candidate"],
        ["candidate", "active"],
      ])
        raw
          .prepare(
            "insert into unit_state (unit_id, from_state, to_state, at, reason, source_id, run_id) values (?, ?, ?, ?, 'saved', ?, ?)",
          )
          .run(unit, from, to, when, source, run);
      raw.prepare("update extraction_run set status = 'saved', finished_at = ? where id = ?").run(when, run);
      raw.close();
      const repo = path.join(locked, "repo");
      fs.mkdirSync(repo);
      execFileSync("git", ["init", "-q"], { cwd: repo });
      execFileSync("git", ["remote", "add", "origin", "https://github.com/example/locked.git"], {
        cwd: repo,
      });
      const read = (session) => {
        const started = performance.now();
        const answer = execFileSync(process.execPath, [path.join(pkg, "dist", "deliver.js")], {
          cwd: repo,
          encoding: "utf8",
          env,
          input: JSON.stringify({
            hook_event_name: "PreToolUse",
            tool_name: "Read",
            tool_input: { file_path: path.join(repo, "src", "db.ts") },
            session_id: `${session}-${process.pid}-${Date.now()}`,
            cwd: repo,
          }),
        });
        return {
          ms: performance.now() - started,
          context: answer ? JSON.parse(answer).hookSpecificOutput?.additionalContext : "",
        };
      };
      const free = read("unlocked");
      if (!free.context?.includes(key))
        fail({
          where: "deliver.js PreToolUse Read (tarball hook)",
          what: `the hook did not deliver ${key} for the file it is anchored to`,
          why: SHIPPED,
          fix: "check the PreToolUse path of server/src/deliver.ts with the context below",
          detail: String(free.context),
        });
      const holder = new DatabaseSync(file);
      let held;
      try {
        holder.exec("begin immediate");
        held = read("locked");
      } finally {
        if (holder.isTransaction) holder.exec("rollback");
        holder.close();
      }
      if (!held.context?.includes(key) || held.ms >= 1000)
        fail({
          where: "deliver.js PreToolUse Read under a write lock (tarball hook)",
          what: `under a write lock the hook took ${Math.round(held.ms)} ms (under 1000 expected)${held.context?.includes(key) ? "" : ` and did not deliver ${key}`}`,
          why: "the host kills a hook after 5 seconds, and another connection may hold the write lock at any time",
          fix: "make server/src/deliver.ts read without waiting on the write lock",
          detail: String(held.context),
        });
      const sub = JSON.parse(
        execFileSync(process.execPath, [path.join(pkg, "dist", "deliver.js")], {
          cwd: repo,
          encoding: "utf8",
          env,
          input: JSON.stringify({
            hook_event_name: "SubagentStart",
            agent_id: "tarball-agent",
            agent_type: "Explore",
            session_id: `subagent-${process.pid}-${Date.now()}`,
            cwd: repo,
          }),
        }) || "{}",
      ).hookSpecificOutput;
      // The whole reply, so a stale bundle that still adds the session-start set to the line does not pass
      if (
        sub?.hookEventName !== "SubagentStart" ||
        sub.additionalContext !== "Sphica: before choosing an approach, search Sphica's past records for it."
      )
        fail({
          where: "deliver.js SubagentStart (tarball hook)",
          what: "the hook did not answer SubagentStart with the search line alone",
          why: "a subagent starts without the main conversation's context, so it is told to search Sphica first and nothing more",
          fix: "check the SubagentStart reply of server/src/deliver.ts, then bundle and pack again",
          detail: JSON.stringify(sub),
        });
    } finally {
      fs.rmSync(locked, { recursive: true, force: true });
    }
    const filesIn = (dir) =>
      fs
        .readdirSync(dir, { withFileTypes: true, recursive: true })
        .filter((e) => e.isFile())
        .map((e) => path.join(e.parentPath, e.name));
    const banned = filesIn(pkg).filter(
      (f) => hasBannedName(path.relative(pkg, f)) || hasBannedName(fs.readFileSync(f, "latin1")),
    );
    if (banned.length)
      fail({
        where,
        what: `the tarball has a banned name in ${banned.map((f) => path.relative(pkg, f)).join(", ")}`,
        why: "the name must not appear in the package, and lib/banned-name.mjs keeps only its hash",
        fix: "remove the name from the sources those files are built from, then bundle and pack again",
      });
    // The package ships no web UI (the UI is the terminal). Assets left here mean bundle forgot to remove them
    if (fs.existsSync(path.join(pkg, "dist", "dashboard")))
      fail({
        where,
        what: "the tarball holds dist/dashboard",
        why: "the package ships no web UI, so these are assets a bundle left behind",
        fix: "remove plugin/dist/dashboard and bundle again from a clean plugin/dist",
      });
    console.log(
      `tarball: ${paths.size} files matching the shipped list. CLI ${version} started, created a database, bound the GitHub account, backed up and migrated an older database the hook named the version for, delivered under a write lock, and answered SubagentStart`,
    );
  } finally {
    fs.rmSync(out, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  }
}
