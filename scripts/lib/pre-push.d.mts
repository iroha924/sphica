// Copyright (c) 2026 iroha924 and contributors
// SPDX-License-Identifier: MIT

export type PushLine = { localRef: string; localOid: string; remoteRef: string; remoteOid: string };
export function pushLines(
  stdin: string,
): { lines: PushLine[]; bad?: undefined } | { bad: string; lines?: undefined };
export function scriptFor(lines: PushLine[]): "verify" | "check";
