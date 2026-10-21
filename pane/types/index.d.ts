// Copyright (c) 2026 iroha924 and contributors
// SPDX-License-Identifier: MIT

import type { Delivered } from "../hooks/sift.ts";

declare module "claude-code" {
  interface PluginState {
    "sphica-pane": { delivered: Delivered[] };
  }
}
