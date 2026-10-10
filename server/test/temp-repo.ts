// Copyright (c) 2026 iroha924 and contributors
// SPDX-License-Identifier: MIT

// Creates a temp repository and passes it to fn. git does not read the default config.
//
// Document import builds SQL from git contents, so the checks need real commits.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export async function withRepo(
  fn: (repo: string, git: (...a: string[]) => string) => void | Promise<void>,
): Promise<void> {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "sphica-docs-")));
  try {
    const repo = path.join(dir, "repo");
    execFileSync("git", ["init", "-q", repo], { stdio: "ignore" });
    const git = (...a: string[]) => execFileSync("git", ["-C", repo, ...a], { encoding: "utf8" }).trim();
    git("config", "user.email", "t@example.com");
    git("config", "user.name", "t");
    fs.writeFileSync(path.join(dir, "outside.env"), "SECRET_TOKEN=sk-live-abc123\n");
    await fn(repo, git);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

export const put = (repo: string, rel: string, body: string): void => {
  fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true });
  fs.writeFileSync(path.join(repo, rel), body);
};
