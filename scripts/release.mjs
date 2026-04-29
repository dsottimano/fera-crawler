#!/usr/bin/env node
/**
 * Cuts a release. Every invocation bumps the version, tags it, pushes, and
 * lets GitHub Actions build the installers and publish the release.
 *
 *   npm run release           → patch bump (default)
 *   npm run release minor     → minor bump
 *   npm run release major     → major bump
 *   npm run release v1.2.3    → literal tag (no auto-bump)
 *
 * The pushed tag triggers `.github/workflows/build.yml` (push: tags ['v*']),
 * which builds .exe / .deb / .AppImage and uploads them to a *published*
 * (non-draft) release that shows up at the top of the repo's Releases page.
 *
 * Requires a clean working tree and `gh` CLI on PATH.
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
  const status = shCapture("git", ["status", "--porcelain"]);
  if (status) {
    console.error("Working tree is dirty. Commit or stash first:\n" + status);
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
  if (/^v\d+\.\d+\.\d+/.test(kind)) return kind;
  const [maj, min, pat] = current.split(".").map((n) => parseInt(n, 10));
  if (kind === "major") return `v${maj + 1}.0.0`;
  if (kind === "minor") return `v${maj}.${min + 1}.0`;
  return `v${maj}.${min}.${pat + 1}`;
}

ensureGh();
ensureClean();

const kind = process.argv[2] ?? "patch";
const pkg = JSON.parse(fs.readFileSync(PKG_PATH, "utf8"));
const newTag = bumpVersion(pkg.version, kind);
const newVersion = newTag.replace(/^v/, "");

console.log(`Bumping ${pkg.version} → ${newVersion} (tag ${newTag})`);

pkg.version = newVersion;
fs.writeFileSync(PKG_PATH, JSON.stringify(pkg, null, 2) + "\n");

const cargoToml = path.join(ROOT, "src-tauri", "Cargo.toml");
let cargo = fs.readFileSync(cargoToml, "utf8");
cargo = cargo.replace(/^version = "[^"]+"/m, `version = "${newVersion}"`);
fs.writeFileSync(cargoToml, cargo);

const tauriConf = path.join(ROOT, "src-tauri", "tauri.conf.json");
const conf = JSON.parse(fs.readFileSync(tauriConf, "utf8"));
conf.version = newVersion;
fs.writeFileSync(tauriConf, JSON.stringify(conf, null, 2) + "\n");

sh("git", ["add", "package.json", "src-tauri/Cargo.toml", "src-tauri/tauri.conf.json"]);
sh("git", ["commit", "-m", `chore: release ${newTag}`]);
sh("git", ["tag", "-a", newTag, "-m", `Release ${newTag}`]);
sh("git", ["push", "origin", "HEAD"]);
sh("git", ["push", "origin", newTag]);

console.log(`\nTag ${newTag} pushed. Build & Release workflow is running.`);
console.log(`Watch:    gh run watch`);
console.log(`Release:  https://github.com/dsottimano/fera-crawler/releases/tag/${newTag}`);
