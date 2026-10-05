// A second `sphica init --name` for the race tests: names dir, telling the parent when the name map's lock is held and when it is done.
// With "die", it exits the moment it would publish the new name map, as a killed init would.
import fs from "node:fs";
import { nameLocal } from "../../src/project.ts";
import { signalDone, signalWhenHeld } from "../race.ts";

const [mode, dir, name, signals] = process.argv.slice(2) as [string, string, string, string];
signalWhenHeld("projects.json.lock", signals);
if (mode === "die") {
  const rename = fs.renameSync;
  fs.renameSync = (from: fs.PathLike, to: fs.PathLike) => {
    if (String(to).endsWith("projects.json")) process.exit(1);
    rename(from, to);
  };
}
nameLocal(dir, name);
signalDone(signals);
