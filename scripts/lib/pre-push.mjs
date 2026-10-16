// Copyright (c) 2026 iroha924 and contributors
// SPDX-License-Identifier: MIT

// Reads Git's pre-push lines and picks what the hook runs for them.

const OID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const ZERO = /^0+$/;

/** Git's pre-push lines (`<local ref> <local oid> <remote ref> <remote oid>`), or the first line that is not one */
export function pushLines(stdin) {
  const lines = [];
  for (const [i, line] of stdin.split("\n").entries()) {
    if (line === "") continue;
    const fields = line.split(" ");
    const [localRef, localOid, remoteRef, remoteOid] = fields;
    if (
      fields.length !== 4 ||
      !localRef ||
      !OID.test(localOid ?? "") ||
      !remoteRef?.startsWith("refs/") ||
      !OID.test(remoteOid ?? "")
    )
      return {
        bad: `line ${i + 1} is not "<local ref> <local oid> <remote ref> <remote oid>": ${JSON.stringify(line.slice(0, 200))}`,
      };
    lines.push({ localRef, localOid, remoteRef, remoteOid });
  }
  return { lines };
}

/** verify for an update of main (a deletion pushes nothing to check), check for anything else */
export const scriptFor = (lines) =>
  lines.some((l) => l.remoteRef === "refs/heads/main" && !ZERO.test(l.localOid)) ? "verify" : "check";
