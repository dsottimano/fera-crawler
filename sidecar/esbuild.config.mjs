import { build } from "esbuild";
import { readFile } from "node:fs/promises";

// Patch playwright-core require.resolve() calls that reference files
// not needed at runtime (package.json path, electron support, app icons)
const patchPlaywrightResolves = {
  name: "patch-playwright-resolves",
  setup(b) {
    b.onLoad({ filter: /playwright-core[/\\]lib[/\\].*\.js$/ }, async (args) => {
      let contents = await readFile(args.path, "utf8");
      contents = contents.replace(
        /require\.resolve\([\"']\.\.\/(\.\.\/)*package\.json[\"']\)/g,
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
