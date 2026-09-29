// Reads the acceptance world and cases and resolves source references to text.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));

export type Step = Record<string, unknown>;
export type Case = {
  id: string;
  layer: string;
  lang: string;
  summary?: string;
  given: Step[];
  when: Step;
  then: Step[];
};
type Turn = { owner: string; assistant: string; edits: string[] };
type Session = { id: string; host?: string; at: string; turns: Turn[] };
type Comment = { id: number; body: string };
type Pull = {
  number: number;
  body: string;
  comments: Comment[];
  review_comments: Comment[];
  commits: { sha: string; message: string }[];
};
export type World = {
  sessions: Session[];
  pulls: Pull[];
  issues: { number: number; body: string; comments: Comment[] }[];
  files: Record<string, string>;
};

export function loadAcceptance(): { world: World; cases: Case[]; setups: Record<string, Step> } {
  const read = (name: string) => JSON.parse(fs.readFileSync(path.join(HERE, name), "utf8"));
  const doc = read("cases.json") as { cases: Case[]; setups: Record<string, Step> };
  return { world: read("world.json") as World, cases: doc.cases, setups: doc.setups };
}

/** Source text by reference, including sessions a case defines inline. */
function sourceTexts(world: World, cases: Case[]): Map<string, string> {
  const texts = new Map<string, string>();
  const addSession = (s: Session) =>
    s.turns.forEach((t, i) => {
      texts.set(`session:${s.id}#${i + 1}.owner`, t.owner);
      texts.set(`session:${s.id}#${i + 1}.assistant`, t.assistant);
    });
  world.sessions.forEach(addSession);
  for (const c of cases) for (const g of c.given) if (g.session) addSession(g.session as Session);
  for (const p of world.pulls) {
    texts.set(`pr:${p.number}#body`, p.body);
    for (const x of p.comments) texts.set(`pr:${p.number}#comment:${x.id}`, x.body);
    for (const x of p.review_comments) texts.set(`pr:${p.number}#review:${x.id}`, x.body);
    for (const x of p.commits) texts.set(`pr:${p.number}#commit:${x.sha}`, x.message);
  }
  for (const i of world.issues) {
    texts.set(`issue:${i.number}#body`, i.body);
    for (const x of i.comments) texts.set(`issue:${i.number}#comment:${x.id}`, x.body);
  }
  return texts;
}

/** Every non-empty quote tied to a session, PR, or issue source, and whether it occurs there. */
export function quoteSources(
  world: World,
  cases: Case[],
  setups: Record<string, Step>,
): { caseId: string; source: string; quote: string; found: boolean }[] {
  const texts = sourceTexts(world, cases);
  const out: { caseId: string; source: string; quote: string; found: boolean }[] = [];
  const walk = (caseId: string, o: unknown): void => {
    if (Array.isArray(o)) for (const v of o) walk(caseId, v);
    else if (o && typeof o === "object") {
      const r = o as Record<string, unknown>;
      if (typeof r.source === "string" && typeof r.quote === "string" && r.quote && texts.has(r.source))
        out.push({
          caseId,
          source: r.source,
          quote: r.quote,
          found: texts.get(r.source)?.includes(r.quote) ?? false,
        });
      for (const v of Object.values(r)) walk(caseId, v);
    }
  };
  for (const c of cases) walk(c.id, c);
  for (const [name, s] of Object.entries(setups)) walk(`setup:${name}`, s);
  return out;
}
