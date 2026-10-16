// Copyright (c) 2026 iroha924 and contributors
// SPDX-License-Identifier: MIT

// Runs every acceptance case in one process against the product through its public entry points. verify runs the same cases split across
// the shard-<k>.ts files instead (`bun run acceptance`); a new case that fails keeps verify red until the feature is built.
import { registerCases } from "./cases-run.ts";

registerCases();
