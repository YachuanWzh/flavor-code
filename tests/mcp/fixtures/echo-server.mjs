import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const server = new McpServer({ name: "flavor-test-echo", version: "1.0.0" });
server.registerTool("echo", {
  description: "Echo a value",
  inputSchema: { value: z.string() },
}, async ({ value }) => ({
  content: [{ type: "text", text: value }],
  structuredContent: { value },
}));

await server.connect(new StdioServerTransport());
