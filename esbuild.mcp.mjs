import esbuild from "esbuild";

const production = process.argv.includes("production");
const watch = process.argv.includes("--watch");

const context = await esbuild.context({
  entryPoints: ["src/mcp/server.ts"],
  outfile: "mcp-server.js",
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node20",
  sourcemap: production ? false : "inline",
  logLevel: "info",
  banner: {
    js: "#!/usr/bin/env node"
  }
});

if (watch) {
  await context.watch();
} else {
  await context.rebuild();
  await context.dispose();
}
