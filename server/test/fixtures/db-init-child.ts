// A second `sphica init` for the race test, on a file system without hard links: creates the database at file, tells the parent when
// the install lock is held, and on success writes its own project row so the test can see whose database survived.
import fs from "node:fs";
import { dbInit } from "../../src/admin.ts";
import { connectWriter } from "../../src/db-write.ts";
import { signalDone, signalWhenHeld } from "../race.ts";

const [file, signals] = process.argv.slice(2) as [string, string];
fs.linkSync = () => {
  throw Object.assign(new Error("hard links are not supported"), { code: "EPERM" });
};
signalWhenHeld(".init.lock", signals);
try {
  dbInit(file);
  const w = connectWriter("owner", file);
  w.prepare("insert into project (key, name) values ('git:example/child', 'child')").run();
  w.close();
} catch (e) {
  console.log((e as Error).message);
}
signalDone(signals);
