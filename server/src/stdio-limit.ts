// Copyright (c) 2026 iroha924 and contributors
// SPDX-License-Identifier: MIT

// The SDK's stdio transport closes itself when its receive buffer passes its limit (10 MiB), and the process then ends as if its
// work were done. A host sees a server that vanished; this says why, and ends with an error.

import type { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

/**
 * Call once the server is connected. Only the close that follows the buffer's own error is turned into a failure: a line that is
 * not JSON does not close the transport, and input that simply ends is the ordinary way to stop.
 */
export function stopOnOverflow(transport: StdioServerTransport): void {
  let over = false;
  const { onerror, onclose } = transport;
  transport.onerror = (e) => {
    // The SDK gives this error no type of its own; a test raises it with the SDK installed, so a change of its words shows
    if (e.message.startsWith("ReadBuffer exceeded maximum size")) over = true;
    onerror?.(e);
  };
  transport.onclose = () => {
    onclose?.();
    if (!over) return;
    process.stderr.write(
      "Sphica: the receive buffer passed 10 MiB, so the server stops. No request in it was run.\n",
    );
    process.exitCode = 1;
  };
}
