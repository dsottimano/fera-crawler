import { build } from "esbuild";

await build({
  entryPoints: ["src/index.ts"],
  bundle: true,
  platform: "node",
  target: "node22",
  format: "cjs",
  outfile: "dist/index.cjs",
  external: ["chromium-bidi"],
  sourcemap: false,
  minify: true,
});

console.log("Sidecar built → dist/index.cjs");
