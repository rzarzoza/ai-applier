// Builds the browser extension into extension/dist (load it unpacked from there): bundles the TypeScript entry points
// with esbuild and copies the manifest and the popup page.
import { copyFileSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "extension");
const out = path.join(root, "dist");

/** esbuild options for one of the extension's scripts (exported for tests that bundle a page-injectable build). */
export const bundleOptions = {
  bundle: true, format: "iife", target: "chrome121", platform: "browser", legalComments: "none", logLevel: "warning",
};

export async function buildExtension(dir = out) {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  await build({
    ...bundleOptions,
    entryPoints: Object.fromEntries(["background", "content", "popup"].map(name => [name, path.join(root, "src", `${name}.ts`)])),
    outdir: dir,
  });
  for (const f of ["manifest.json", "popup.html"]) copyFileSync(path.join(root, f), path.join(dir, f));
  return dir;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const dir = await buildExtension(process.argv[2] ? path.resolve(process.argv[2]) : out);
  console.log(`Built the extension into ${path.relative(process.cwd(), dir) || dir}`);
}
