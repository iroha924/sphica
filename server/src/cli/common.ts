// Helpers the CLI commands share: connections by role, the project of the working directory, and the host session.
import type { Kysely } from "kysely";
import { openReader, type Role } from "../db.ts";
import type { DB } from "../db-types.ts";
import { openWriter } from "../db-write.ts";
import { HOSTS, type Host } from "../knowledge.ts";
import { identify, type Place, projectId } from "../project.ts";

export async function withDb<T>(
  role: Exclude<Role, "owner">,
  fn: (db: Kysely<DB>) => Promise<T>,
): Promise<T> {
  const db = role === "reader" ? openReader() : openWriter(role);
  try {
    return await fn(db);
  } finally {
    await db.destroy().catch(() => {});
  }
}

export function placeOf(cwd: string): Place {
  const place = identify(cwd);
  if (!place)
    throw new Error(`${cwd} has no git remote and no name. Name it with \`sphica init --name <name>\``);
  return place;
}

export async function registered(db: Kysely<DB>, place: Place): Promise<number> {
  const id = await projectId(db, place.key);
  if (id === null)
    throw new Error(`${place.name} is not registered with Sphica. Register it with \`sphica init\``);
  return id;
}

const SESSION_ENV: Record<Host, string[]> = {
  "claude-code": ["CLAUDE_CODE_SESSION_ID"],
  codex: ["CODEX_THREAD_ID", "CODEX_SESSION_ID"],
};

/**
 * The current session. **When both hosts' ids are in the environment, it does not choose** (Codex started from Claude Code's Bash
 * inherits CLAUDE_CODE_SESSION_ID; taking whichever comes first would read and write another host's session).
 */
export function hostSession(host?: Host): { host: Host; id: string } {
  const found = HOSTS.flatMap((h) => {
    const id = SESSION_ENV[h].map((k) => process.env[k]).find(Boolean);
    return id && (!host || h === host) ? [{ host: h, id }] : [];
  });
  if (found.length === 1 && found[0]) return found[0];
  if (found.length > 1)
    throw new Error(
      "Both Claude Code and Codex sessions are in the environment. Name your host with --host claude-code or --host codex",
    );
  throw new Error(
    host
      ? `No ${host} session id in the environment (${SESSION_ENV[host].join(" / ")})`
      : "Cannot tell the current session (run this inside Claude Code or Codex, or pass --session from trace pending)",
  );
}
