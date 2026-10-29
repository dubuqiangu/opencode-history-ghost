// Stamps dist/tui.js with the exact bytes that were built, so "which version is
// the host actually running?" stops being guesswork.
//
// Writes dist/build-stamp.json: { sha256, bytes, builtAt, commit }.
// The hash is of dist/tui.js itself; `commit` is whatever git reports, or
// "nogit" outside a checkout. Nothing here throws on a missing git: absence of
// a commit is information, not a failure to build.
//
// Run: node scripts/stamp-build.mjs

import { createHash } from "node:crypto"
import { execFileSync } from "node:child_process"
import { readFileSync, statSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const artifactPath = join(repositoryRoot, "dist", "tui.js")
const stampPath = join(repositoryRoot, "dist", "build-stamp.json")

function readCommit() {
  try {
    const commit = execFileSync("git", ["rev-parse", "--short", "HEAD"], {
      cwd: repositoryRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim()
    return commit.length > 0 ? commit : "nogit"
  } catch {
    return "nogit"
  }
}

const artifactBytes = readFileSync(artifactPath)
const sha256 = createHash("sha256").update(artifactBytes).digest("hex")
const bytes = statSync(artifactPath).size
const builtAt = new Date().toISOString()
const commit = readCommit()

writeFileSync(stampPath, JSON.stringify({ sha256, bytes, builtAt, commit }, null, 2) + "\n", "utf8")

console.log(`stamped dist/tui.js bytes=${bytes} sha256=${sha256} commit=${commit} builtAt=${builtAt}`)
