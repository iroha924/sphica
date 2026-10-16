// Copyright (c) 2026 iroha924 and contributors
// SPDX-License-Identifier: MIT

// One share of the acceptance cases; its number comes from the file name (see cases-run.ts).
import { inShard, registerCases, shardCount, shardOf } from "./cases-run.ts";

const k = shardOf(import.meta.filename);
const n = shardCount();
registerCases((i) => inShard(i, k, n));
