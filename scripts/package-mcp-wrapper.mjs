import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const distName = "yoofloe-obsidian-mcp-wrapper";
const stagingDir = join(root, "dist", distName);
const zipPath = join(root, `${distName}.zip`);

function requireFile(path, label) {
  if (!existsSync(path)) {
    throw new Error(`${label} is missing at ${path}. Run npm run build:mcp first.`);
  }
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: root,
    stdio: "inherit",
    shell: process.platform === "win32",
    ...options
  });

  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed with exit code ${result.status ?? "unknown"}.`);
  }
}

const mcpServer = join(root, "mcp-server.js");
const readme = join(root, "docs", "README-mcp-wrapper.txt");
const license = join(root, "LICENSE");

requireFile(mcpServer, "MCP server bundle");
requireFile(readme, "MCP wrapper README");

rmSync(stagingDir, { recursive: true, force: true });
rmSync(zipPath, { force: true });
mkdirSync(stagingDir, { recursive: true });

cpSync(mcpServer, join(stagingDir, "mcp-server.js"));
cpSync(readme, join(stagingDir, "README.txt"));
if (existsSync(license)) {
  cpSync(license, join(stagingDir, "LICENSE"));
}

if (process.platform === "win32") {
  run("powershell", [
    "-NoProfile",
    "-Command",
    `Compress-Archive -Path '${stagingDir.replace(/'/g, "''")}\\*' -DestinationPath '${zipPath.replace(/'/g, "''")}' -Force`
  ]);
} else {
  run("zip", ["-r", zipPath, "."], { cwd: stagingDir });
}

console.log(`Created ${zipPath}`);
