import { build } from "esbuild";
import { readFile } from "node:fs/promises";

// Patch playwright-core files that use require.resolve() for paths
// that don't exist inside a pkg'd binary. These are non-essential
// (stack trace filtering, electron support, app icons).
const patchPlaywrightResolves = {
  name: "patch-playwright-resolves",
  setup(b) {
    b.onLoad({ filter: /playwright-core[/\\]lib[/\\].*\.js$/ }, async (args) => {
      let contents = await readFile(args.path, "utf8");
      // Replace require.resolve("../../../package.json") → __dirname
      // Used only for stack trace prefix filtering, not browser launching
      contents = contents.replace(
        /require\.resolve\(["']\.\.\/\.\.\/\.\.\/package\.json["']\)/g,
        "__dirname",
      );
      return { contents, loader: "js" };
    });
  },
};

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
  plugins: [patchPlaywrightResolves],
});

console.log("Sidecar built → dist/index.cjs");
