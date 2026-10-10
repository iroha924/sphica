// Copyright (c) 2026 iroha924 and contributors
// SPDX-License-Identifier: MIT

// Settings a release relies on that only an admin can read: each is on, off, or unknown, and a failed read is never taken as off.
import "./isolate-home.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { observe, settingsState } from "../../scripts/lib/repo-settings.mjs";

const states = (immutable: object, actions: object) =>
  settingsState({ immutable, actions } as Parameters<typeof settingsState>[0]).map((s) => s.state);

test("each setting is on, off, or unknown from the status and body gh returned", () => {
  const on = { status: 200, body: { enabled: true } };
  const pinned = { status: 200, body: { sha_pinning_required: true } };
  assert.deepEqual(states(on, pinned), ["on", "on"]);
  assert.deepEqual(
    states({ status: 200, body: { enabled: false } }, { status: 200, body: { sha_pinning_required: false } }),
    ["off", "off"],
  );
  // A 404 may be a wrong repository name or no access, so it is not taken as off
  assert.deepEqual(states({ status: 404, body: null }, pinned), ["unknown", "on"]);
  for (const unseen of [
    { status: null, body: null },
    { status: 403, body: null },
    { status: 200, body: {} },
  ])
    assert.deepEqual(states(unseen, unseen), ["unknown", "unknown"], JSON.stringify(unseen));
});

test("observe takes the HTTP status from gh's error text and never guesses one", () => {
  assert.deepEqual(
    observe(() => '{"enabled":true}', "x"),
    { status: 200, body: { enabled: true } },
  );
  const failing = (stderr: string) => () => {
    throw Object.assign(new Error("gh failed"), { stderr });
  };
  assert.deepEqual(observe(failing("gh: Not Found (HTTP 404)\n"), "x"), { status: 404, body: null });
  assert.deepEqual(observe(failing("gh: Must have admin rights (HTTP 403)\n"), "x"), {
    status: 403,
    body: null,
  });
  assert.deepEqual(observe(failing("error connecting to api.github.com\n"), "x"), {
    status: null,
    body: null,
  });
  assert.deepEqual(
    observe(() => "not json", "x"),
    { status: null, body: null },
  );
});
