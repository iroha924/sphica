// Copyright (c) 2026 iroha924 and contributors
// SPDX-License-Identifier: MIT

/** One piece of Sphica's text a hook handed the agent, as the pane keeps it. */
export type Delivered = { at: string; event: string; kind: "context" | "stop"; text: string };

declare module "claude-code" {
  interface PluginState {
    "sphica-pane": { delivered: Delivered[] };
  }
}
