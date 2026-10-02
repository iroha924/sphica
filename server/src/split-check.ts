// The fixed samples terms() is pinned to, checked against this Node. Intl.Segmenter splits by the ICU Node ships, so another Node may
// split the same text differently from the rules the indexes were written with, and searches then miss rows written the other way.

import golden from "./terms-golden.json" with { type: "json" };
import { terms } from "./text.ts";

export type Sample = { text: string; terms: string[] };

export const SAMPLES: Sample[] = golden.cases;

/** The samples this Node splits differently from their pinned output. */
export const splitDrift = (samples: Sample[] = SAMPLES): Sample[] =>
  samples.filter((c) => JSON.stringify(terms(c.text)) !== JSON.stringify(c.terms));

/** doctor's line for it. A mismatch is not mended by rebuilding the index, which splits with this same Node, so the line never says so. */
export function splitLine(
  samples: Sample[] = SAMPLES,
  icu = process.versions.icu,
): { mark: "ok" | "warn"; text: string } {
  const drift = splitDrift(samples);
  return drift.length
    ? {
        mark: "warn",
        text: `${drift.length} of ${samples.length} fixed samples split differently with ICU ${icu}: searches may miss records written by a Node that splits as Sphica's rules do. Run Sphica with such a Node`,
      }
    : { mark: "ok", text: `matches the fixed samples (ICU ${icu})` };
}
