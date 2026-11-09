import { copyFile } from "node:fs/promises";

// A single browser build is authoritative for development and public release assets.
await import("./calendar-companion/build.mjs");
for (const name of ["main.js", "manifest.json", "styles.css"]) {
  await copyFile(new URL(`./calendar-companion/dist/${name}`, import.meta.url), new URL(`./${name}`, import.meta.url));
}
