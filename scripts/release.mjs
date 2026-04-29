#!/usr/bin/env node
/**
 * Trigger the Build & Release GitHub Action.
 *
 * Two modes:
 *   npm run release                  → workflow_dispatch on the current branch
 *                                       (no tag created; produces a draft
 *                                       release named after the branch).
 *   npm run release -- --tag         → bump patch version, create v<X.Y.Z>
 *                                       tag, push it. The workflow's
 *                                       `push: tags: ['v*']` trigger fires;
 *                                       installer is published under that
 *                                       tag.
 *   npm run release -- --tag minor   → same but bump minor / major.
 *   npm run release -- --tag major
 *   npm run release -- --tag v1.2.3  → use a literal tag (no auto-bump).
 *
 * Requires `gh` CLI logged in. The script checks for a clean working tree
 * before tagging — half-finished local changes shouldn't ride into a
 * release commit.
 */
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PKG_PATH = path.join(ROOT, "package.json");

function sh(cmd, args, opts = {}) {
  return execFileSync(cmd, args, { stdio: "inherit", cwd: ROOT, ...opts });
}

function shCapture(cmd, args) {
  return execFileSync(cmd, args, { encoding: "utf8", cwd: ROOT }).trim();
}

function ensureClean() {
  try {
    const status = shCapture("git", ["status", "--porcelain"]);
    if (status) {
      console.error("Working tree is dirty. Commit or stash before tagging:\n" + status);
      process.exit(1);
    }
  } catch (e) {
    console.error("Failed to read git status:", e.message);
    process.exit(1);
  }
}

function ensureGh() {
  const r = spawnSync("gh", ["--version"], { stdio: "ignore" });
  if (r.status !== 0) {
    console.error("gh CLI not found. Install: https://cli.github.com/");
    process.exit(1);
  }
}

function bumpVersion(current, kind) {
  // Literal tag like "v1.2.3" → use as-is, don't bump.
  if (/^v\d+\.\d+\.\d+/.test(kind)) return kind;
  const [maj, min, pat] = current.split(".").map((n) => parseInt(n, 10));
  if (kind === "major") return `v${maj + 1}.0.0`;
  if (kind === "minor") return `v${maj}.${min + 1}.0`;
  // Default: patch.
  return `v${maj}.${min}.${pat + 1}`;
}

const args = process.argv.slice(2);
const tagIdx = args.indexOf("--tag");
const wantTag = tagIdx !== -1;

ensureGh();

if (!wantTag) {
  // workflow_dispatch path. Picks the current branch automatically.
  const branch = shCapture("git", ["rev-parse", "--abbrev-ref", "HEAD"]);
  console.log(`Dispatching build.yml on branch ${branch}…`);
  sh("gh", ["workflow", "run", "build.yml", "--ref", branch]);
  console.log("\nWorkflow dispatched. Watch progress with:");
  console.log("  gh run watch");
  console.log("\nThis produces a draft release named after the branch.");
  console.log("To publish under a real version tag, use: npm run release -- --tag");
  process.exit(0);
}

// Tag path.
ensureClean();
const pkg = JSON.parse(fs.readFileSync(PKG_PATH, "utf8"));
const kind = args[tagIdx + 1] ?? "patch";
const newTag = bumpVersion(pkg.version, kind);
const newVersion = newTag.replace(/^v/, "");

console.log(`Bumping ${pkg.version} → ${newVersion} (tag ${newTag})`);

// Update package.json so the in-app About modal reflects the new version.
pkg.version = newVersion;
fs.writeFileSync(PKG_PATH, JSON.stringify(pkg, null, 2) + "\n");

// Update src-tauri/Cargo.toml + tauri.conf.json so the installer metadata matches.
const cargoToml = path.join(ROOT, "src-tauri", "Cargo.toml");
let cargo = fs.readFileSync(cargoToml, "utf8");
cargo = cargo.replace(/^version = "[^"]+"/m, `version = "${newVersion}"`);
fs.writeFileSync(cargoToml, cargo);

const tauriConf = path.join(ROOT, "src-tauri", "tauri.conf.json");
const conf = JSON.parse(fs.readFileSync(tauriConf, "utf8"));
conf.version = newVersion;
fs.writeFileSync(tauriConf, JSON.stringify(conf, null, 2) + "\n");

// Commit, tag, push. The push triggers build.yml via `push: tags: ['v*']`.
sh("git", ["add", "package.json", "src-tauri/Cargo.toml", "src-tauri/tauri.conf.json"]);
sh("git", ["commit", "-m", `chore: release ${newTag}`]);
sh("git", ["tag", "-a", newTag, "-m", `Release ${newTag}`]);
sh("git", ["push", "origin", "HEAD"]);
sh("git", ["push", "origin", newTag]);

console.log(`\nTag ${newTag} pushed. The Build & Release workflow is now running.`);
console.log("Watch progress with:  gh run watch");
console.log(`Release page:         gh release view ${newTag}`);
