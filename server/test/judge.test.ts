// The successor rules as pure cases: each names the review finding or design point whose input it replays.

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  difference,
  type Intent,
  type Judged,
  judge,
  type Lifecycle,
  type OpenRow,
  type Snapshot,
  type UnitFacts,
} from "../src/judge.ts";

// A decision adopted by the owner, sound and supported, stored as given; override what the case needs
const unit = (id: number, lifecycle: Lifecycle | null, v: Partial<UnitFacts> = {}): UnitFacts => ({
  id,
  kind: "decision",
  lifecycle,
  withdrawn: lifecycle === "withdrawn",
  sound: true,
  quarantined: false,
  supported: true,
  ownerAdopted: true,
  ...v,
});
const intent = (from: number, to: number, addedAt = `2026-10-0${from}T00:00:00.000Z`): Intent => ({
  from,
  to,
  addedAt,
});
const snap = (units: UnitFacts[], intents: Intent[] = [], open: OpenRow[] = []): Snapshot => ({
  units,
  intents,
  open,
});
const states = (j: Judged) => Object.fromEntries([...j.lifecycle].sort(([a], [b]) => a - b));
const holders = (j: Judged) => Object.fromEntries(j.holders);

const O = 1;
const A = 2;
const B = 3;
const P = 4;

test("judge: a waiting proposal never holds the place, so withdrawing the owner's successor brings the owner's decision back (T04 F1)", () => {
  const j = judge(
    snap(
      [unit(O, "superseded"), unit(A, "withdrawn"), unit(P, "candidate", { ownerAdopted: false })],
      [intent(A, O), intent(P, O)],
      [{ from: A, to: O }],
    ),
  );
  assert.deepEqual(states(j), { [O]: "active", [A]: "withdrawn", [P]: "candidate" });
  assert.deepEqual(j.waits.get(P), { why: "no owner adoption" });
});

test("judge: in one save, an unadopted proposal and the owner's successor give the same result in either order (T04 F2, T18 F3)", () => {
  const units = [unit(O, "active"), unit(P, null, { ownerAdopted: false }), unit(A, null)];
  const ab = judge(
    snap(units, [intent(P, O, "2026-10-01T00:00:00.000Z"), intent(A, O, "2026-10-01T00:00:00.000Z")]),
  );
  const ba = judge(
    snap([...units].reverse(), [
      intent(A, O, "2026-10-01T00:00:00.000Z"),
      intent(P, O, "2026-10-01T00:00:00.000Z"),
    ]),
  );
  assert.deepEqual(states(ab), { [O]: "superseded", [A]: "active", [P]: "candidate" });
  assert.deepEqual(states(ba), states(ab));
  assert.deepEqual(holders(ab), { [O]: A });
});

test("judge: two adopted successors of one record: the one holding the place keeps it, and the other waits naming it (T18 F1, C25, C28)", () => {
  // B's intent was saved first, but A holds the place and still stands
  const j = judge(
    snap(
      [unit(O, "superseded"), unit(A, "active"), unit(B, "candidate")],
      [intent(B, O, "2026-10-01T00:00:00.000Z"), intent(A, O, "2026-10-02T00:00:00.000Z")],
      [{ from: A, to: O }],
    ),
  );
  assert.deepEqual(states(j), { [O]: "superseded", [A]: "active", [B]: "candidate" });
  assert.deepEqual(j.waits.get(B), { why: "place held", holder: A });
  // A falls: the place is free, and B takes it
  const k = judge(
    snap(
      [unit(O, "superseded"), unit(A, "active", { supported: false }), unit(B, "candidate")],
      [intent(B, O), intent(A, O)],
      [{ from: A, to: O }],
    ),
  );
  assert.deepEqual(states(k), { [O]: "superseded", [A]: "candidate", [B]: "active" });
  assert.deepEqual(holders(k), { [O]: B });
});

test("judge: taking back the successor's adoption brings the replaced record back (T18 F2)", () => {
  const j = judge(
    snap(
      [unit(O, "superseded"), unit(A, "active", { ownerAdopted: false, supported: false })],
      [intent(A, O)],
      [{ from: A, to: O }],
    ),
  );
  assert.deepEqual(states(j), { [O]: "active", [A]: "candidate" });
  assert.deepEqual(
    difference(
      snap(
        [unit(O, "superseded"), unit(A, "active", { ownerAdopted: false, supported: false })],
        [intent(A, O)],
        [{ from: A, to: O }],
      ),
      j,
    ),
    {
      close: [{ from: A, to: O }],
      open: [],
      transitions: [
        { unit: O, from: "superseded", to: "active" },
        { unit: A, from: "active", to: "candidate" },
      ],
    },
  );
});

test("judge: a withdrawn successor is never the current one (T18 F4)", () => {
  const j = judge(
    snap(
      [unit(O, "superseded"), unit(A, "withdrawn"), unit(B, "active")],
      [intent(A, O), intent(B, O)],
      [{ from: B, to: O }],
    ),
  );
  assert.deepEqual(holders(j), { [O]: B });
});

test("judge: when the end of a chain loses its adoption, the middle comes back and still replaces the head (T19 F1)", () => {
  const facts = snap(
    [unit(O, "superseded"), unit(A, "superseded"), unit(B, "active", { ownerAdopted: false })],
    [intent(A, O), intent(B, A)],
    [
      { from: A, to: O },
      { from: B, to: A },
    ],
  );
  const j = judge(facts);
  assert.deepEqual(states(j), { [O]: "superseded", [A]: "active", [B]: "candidate" });
  assert.deepEqual(difference(facts, j).close, [{ from: B, to: A }]);
});

test("judge: adding or taking back the replaced record's own adoption changes nothing about its successor (T19 F2, F3)", () => {
  for (const ownerAdopted of [true, false]) {
    const j = judge(
      snap(
        [unit(O, "superseded", { ownerAdopted }), unit(A, "active")],
        [intent(A, O)],
        [{ from: A, to: O }],
      ),
    );
    assert.deepEqual(holders(j), { [O]: A });
  }
  // Two proposals waiting beside an owner's decision whose adoption is taken back: the first adopted takes the place, no error
  const j = judge(
    snap(
      [
        unit(O, "candidate", { ownerAdopted: false, supported: false }),
        unit(A, "candidate"),
        unit(B, "candidate", { ownerAdopted: false }),
      ],
      [intent(A, O), intent(B, O)],
    ),
  );
  assert.deepEqual(states(j), { [O]: "superseded", [A]: "active", [B]: "candidate" });
});

test("judge: facts already judged give no difference, whatever order they were written in (T20 F1, C20)", () => {
  const facts = snap(
    [unit(O, "superseded"), unit(A, "superseded"), unit(B, "active")],
    [intent(A, O), intent(B, A)],
    [
      { from: A, to: O },
      { from: B, to: A },
    ],
  );
  assert.deepEqual(difference(facts, judge(facts)), { close: [], open: [], transitions: [] });
  const shuffled = snap([...facts.units].reverse(), [...facts.intents].reverse(), [...facts.open].reverse());
  assert.deepEqual(difference(shuffled, judge(shuffled)), { close: [], open: [], transitions: [] });
});

test("judge: a superseded record whose successors all wait comes back on its own facts (T20 F2)", () => {
  const j = judge(
    snap([unit(O, "superseded"), unit(A, "candidate", { ownerAdopted: false })], [intent(A, O)]),
  );
  assert.deepEqual(states(j), { [O]: "active", [A]: "candidate" });
  const k = judge(
    snap(
      [unit(O, "superseded", { supported: false }), unit(A, "candidate", { ownerAdopted: false })],
      [intent(A, O)],
    ),
  );
  assert.deepEqual(states(k), { [O]: "candidate", [A]: "candidate" });
});

test("judge: re-adopting the end of a closed chain replaces the whole chain again, never leaving two answers (C18)", () => {
  const j = judge(
    snap([unit(O, "candidate"), unit(A, "candidate"), unit(B, "candidate")], [intent(A, O), intent(B, A)]),
  );
  assert.deepEqual(states(j), { [O]: "superseded", [A]: "superseded", [B]: "active" });
});

test("judge: an AI's adoption alone never makes a replacement take effect, and losing or regaining the owner's adoption is seen with no state change (C2, C22)", () => {
  const j = judge(
    snap(
      [unit(O, "superseded"), unit(A, "active", { ownerAdopted: false })],
      [intent(A, O)],
      [{ from: A, to: O }],
    ),
  );
  assert.deepEqual(states(j), { [O]: "active", [A]: "candidate" });
  assert.deepEqual(j.waits.get(A), { why: "no owner adoption" });
  // Not owned kinds replace on support alone
  const k = judge(
    snap(
      [
        unit(O, "active", { kind: "finding", ownerAdopted: false }),
        unit(A, null, { kind: "finding", ownerAdopted: false }),
      ],
      [intent(A, O)],
    ),
  );
  assert.deepEqual(states(k), { [O]: "superseded", [A]: "active" });
});

test("judge: a superseded middle record that loses its support stops replacing the head and stays replaced itself (C23)", () => {
  const j = judge(
    snap(
      [unit(O, "superseded"), unit(A, "superseded", { supported: false }), unit(B, "active")],
      [intent(A, O), intent(B, A)],
      [
        { from: A, to: O },
        { from: B, to: A },
      ],
    ),
  );
  assert.deepEqual(states(j), { [O]: "active", [A]: "superseded", [B]: "active" });
  assert.deepEqual(holders(j), { [A]: B });
});

test("judge: unsound units never become active, quarantined ones are never replaced, and kinds that cannot replace each other wait (C26)", () => {
  const j = judge(
    snap(
      [
        unit(O, "candidate", { sound: false, quarantined: true }),
        unit(A, null),
        unit(B, "active", { kind: "finding", ownerAdopted: false }),
        unit(P, null, { kind: "finding", ownerAdopted: false }),
      ],
      [intent(A, O), intent(P, A)],
    ),
  );
  assert.deepEqual(states(j), { [O]: "candidate", [A]: "candidate", [B]: "active", [P]: "candidate" });
  assert.deepEqual(j.waits.get(O), { why: "unsound" });
  assert.deepEqual(j.waits.get(A), { why: "target quarantined" });
  assert.deepEqual(j.waits.get(P), { why: "kinds" });
});

test("judge: a replaced record comes straight back to active, and a withdrawal is final (C29)", () => {
  const facts = snap([unit(O, "superseded"), unit(A, "withdrawn")], [intent(A, O)], [{ from: A, to: O }]);
  assert.deepEqual(difference(facts, judge(facts)).transitions, [
    { unit: O, from: "superseded", to: "active" },
  ]);
  const back = snap([unit(O, "withdrawn")]);
  assert.throws(
    () =>
      difference(
        { ...back, units: [{ ...unit(O, "withdrawn"), withdrawn: false }] },
        judge(snap([unit(O, null)])),
      ),
    /final/,
  );
  const replaced = snap(
    [unit(O, "superseded", { withdrawn: true }), unit(A, "active")],
    [intent(A, O)],
    [{ from: A, to: O }],
  );
  assert.throws(() => difference(replaced, judge(replaced)), /superseded; withdraw what replaced it/);
});

test("judge: a new unit starts as a candidate, and a proposal into a withdrawn record waits", () => {
  const facts = snap([unit(O, "withdrawn"), unit(A, null)], [intent(A, O)]);
  const j = judge(facts);
  assert.deepEqual(j.waits.get(A), { why: "target withdrawn" });
  assert.deepEqual(difference(facts, j).transitions, [{ unit: A, from: null, to: "candidate" }]);
  const fresh = snap([unit(O, null)]);
  assert.deepEqual(difference(fresh, judge(fresh)).transitions, [
    { unit: O, from: null, to: "candidate" },
    { unit: O, from: "candidate", to: "active" },
  ]);
});

test("judge: a record whose source is gone can still be replaced, which is how it is fixed", () => {
  const j = judge(snap([unit(O, "candidate", { sound: false }), unit(A, null)], [intent(A, O)]));
  assert.deepEqual(states(j), { [O]: "superseded", [A]: "active" });
});
