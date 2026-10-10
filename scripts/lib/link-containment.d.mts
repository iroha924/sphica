// Copyright (c) 2026 iroha924 and contributors
// SPDX-License-Identifier: MIT

export function linksOutside(
  report: { successful?: number; success_map?: Record<string, { url: string }[]> },
  root: string,
): { source: string; url: string }[];
