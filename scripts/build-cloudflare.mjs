import { mkdir, copyFile, rm } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const out = resolve(root, "dist-cloudflare");
const files = ["index.html", "tg-feeds.json", "jin10-calendar.json"];

await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });

for (const file of files) {
  await copyFile(resolve(root, file), resolve(out, file));
}

console.log(`Cloudflare assets built: ${out}`);
