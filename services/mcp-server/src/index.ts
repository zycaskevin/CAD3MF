import { serveStdio } from "@modelcontextprotocol/server/stdio";

import { createCadDeskServer } from "./server.js";

void serveStdio(() => createCadDeskServer());
console.error("CAD3MF MCP server running on stdio");
