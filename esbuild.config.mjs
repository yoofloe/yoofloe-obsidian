import esbuild from "esbuild";
import process from "node:process";

const production = process.argv.includes("production");
const watch = process.argv.includes("--watch");

const context = await esbuild.context({
  entryPoints: ["src/main.ts"],
  bundle: true,
  outfile: "main.js",
  platform: "browser",
  format: "cjs",
  external: ["obsidian", "electron", "node:http"],
  target: "es2020",
  sourcemap: production ? false : "inline",
  minify: production,
  treeShaking: true,
  logLevel: "info"
});

if (watch) {
  await context.watch();
} else {
  await context.rebuild();
  await context.dispose();
}
