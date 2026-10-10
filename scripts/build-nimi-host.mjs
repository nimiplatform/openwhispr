import { build } from "esbuild";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
await mkdir(path.join(root, "dist-electron"), { recursive: true });
const manifest = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
await writeFile(
  path.join(root, "dist-electron/package.json"),
  JSON.stringify(
    {
      name: manifest.name,
      version: manifest.version,
      type: "module",
      main: "main.js",
    },
    null,
    2
  ) + "\n"
);
await build({
  entryPoints: [path.join(root, "src-electron/main.mjs")],
  outfile: path.join(root, "dist-electron/main.js"),
  platform: "node",
  format: "esm",
  target: "node24",
  bundle: false,
});
await build({
  entryPoints: [path.join(root, "preload.js")],
  outfile: path.join(root, "dist-electron/preload.cjs"),
  platform: "node",
  format: "cjs",
  target: "node24",
  bundle: true,
  external: ["electron"],
});
