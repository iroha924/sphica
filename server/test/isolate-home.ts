// Loaded before every test file (the test script's --import): HOME and the temp directory move to a fresh directory of this process, so
// no test reaches the owner's ~/.sphica (Sphica keeps its isolated git directories there), and HOME's .sphica is apart from the temp
// directory, as Sphica requires before it compares a work tree.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Also imported first by every test file, so running one file directly is isolated too; the second load in a process does nothing
if (!process.env.SPHICA_TEST_ISOLATED) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "sphica-test-")));
  const home = path.join(base, "home");
  const tmp = path.join(base, "tmp");
  fs.mkdirSync(home);
  fs.mkdirSync(tmp);
  Object.assign(process.env, {
    HOME: home,
    USERPROFILE: home,
    TMPDIR: tmp,
    TMP: tmp,
    TEMP: tmp,
    SPHICA_TEST_ISOLATED: base,
  });
  // Either would point Sphica past the swapped HOME at the owner's database or queue
  delete process.env.SPHICA_DB;
  delete process.env.SPHICA_HOME;
  process.on("exit", () => {
    try {
      fs.rmSync(base, { recursive: true, force: true });
    } catch {
      // a directory a test locked stays; sql:reach then names it
    }
  });
}
