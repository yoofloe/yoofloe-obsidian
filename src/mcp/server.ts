import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { readMcpConfig, registerYoofloeTools } from "./tools";

async function main() {
  const config = readMcpConfig(process.env);
  const server = new McpServer({
    name: "yoofloe-obsidian-mcp",
    version: config.pluginVersion
  });

  registerYoofloeTools(server, config);

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
