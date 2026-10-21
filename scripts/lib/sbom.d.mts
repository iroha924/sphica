// Copyright (c) 2026 iroha924 and contributors
// SPDX-License-Identifier: MIT

import type { Finding } from "./finding.mjs";

export function sbomProblems(noticesText: string, bom: unknown, file: string): Finding[];
