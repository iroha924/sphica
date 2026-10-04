// What a delivered record carries besides its text: when it was saved, who adopted it, whose words it rests on, and whether the code
// its anchors point at is still where it was. Read in one pass for the records one delivery shows.
import { type AnchorState, checkAnchor } from "./anchors.ts";
import type { Reads } from "./db.ts";
import { cut } from "./text.ts";

export type Speaker = "owner" | "maintainer" | "third_party" | "assistant";

export type Provenance = {
  /** The month the record was saved (not when it was said), YYYY-MM */
  saved: string;
  /** The strongest live adoption: the owner over a maintainer over anyone else; null for a record nobody adopted */
  adopter: Speaker | null;
  /** Whose words its live evidence is; a quote the owner reports from someone else counts as that someone */
  speakers: Speaker[];
  /** The worst state of its live applies_to anchors (missing over moved over unknown over located); null without one */
  anchor: AnchorState | null;
  /** The exact words of its first live stating evidence */
  quote: string | null;
};

type Author = { author_kind: string; author_association: string | null };

/** The owner by the session or the repository; a maintainer by membership; an agent or bot as the assistant; everyone else a third party. */
export function speakerOf(a: Author): Speaker {
  if (a.author_kind === "owner" || a.author_association === "OWNER") return "owner";
  if (a.author_kind === "assistant" || a.author_kind === "bot") return "assistant";
  if (a.author_association === "MEMBER" || a.author_association === "COLLABORATOR") return "maintainer";
  return "third_party";
}

const RANK: Speaker[] = ["owner", "maintainer", "third_party", "assistant"];
const WORST: AnchorState[] = ["missing", "moved", "unknown", "located"];

export async function provenance(
  db: Reads,
  ids: number[],
  root: string | null,
): Promise<Map<number, Provenance>> {
  if (!ids.length) return new Map();
  const [units, adoptions, evidence, anchors] = await Promise.all([
    db.selectFrom("unit").select(["id", "created_at"]).where("id", "in", ids).execute(),
    db
      .selectFrom("unit_adoption as a")
      .innerJoin("source as s", "s.id", "a.source_id")
      .select(["a.unit_id", "s.author_kind", "s.author_association"])
      .where("a.unit_id", "in", ids)
      .where("a.retracted_at", "is", null)
      .execute(),
    db
      .selectFrom("unit_evidence as e")
      .innerJoin("source as s", "s.id", "e.source_id")
      .select([
        "e.unit_id",
        "e.role",
        "e.reported_speaker",
        "e.span_start",
        "e.span_end",
        "s.text",
        "s.author_kind",
        "s.author_association",
      ])
      .where("e.unit_id", "in", ids)
      .where("e.option_id", "is", null)
      .where("e.retracted_at", "is", null)
      .orderBy("e.id")
      .execute(),
    db
      .selectFrom("unit_anchor")
      .select(["unit_id", "path", "symbol", "line_start"])
      .where("unit_id", "in", ids)
      .where("role", "=", "applies_to")
      .where("retired_at", "is", null)
      .execute(),
  ]);
  const out = new Map<number, Provenance>();
  for (const u of units) {
    const adopted = adoptions.filter((a) => a.unit_id === u.id).map(speakerOf);
    const said = evidence.filter((e) => e.unit_id === u.id);
    // The owner repeating someone else's words is hearsay: the words are that someone's
    const speakers = [...new Set(said.map((e) => (e.reported_speaker ? "third_party" : speakerOf(e))))].sort(
      (a, b) => RANK.indexOf(a) - RANK.indexOf(b),
    );
    const states = anchors.filter((a) => a.unit_id === u.id).map((a) => checkAnchor(root, a).state);
    const stating = said.find((e) => e.role === "states") ?? said[0];
    out.set(u.id, {
      saved: u.created_at.slice(0, 7),
      adopter: adopted.sort((a, b) => RANK.indexOf(a) - RANK.indexOf(b))[0] ?? null,
      speakers,
      anchor: states.length ? (WORST.find((w) => states.includes(w)) ?? null) : null,
      quote: stating ? cut(stating.text, stating.span_start, stating.span_end) : null,
    });
  }
  return out;
}
