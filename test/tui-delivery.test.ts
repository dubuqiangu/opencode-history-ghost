/**
 * Project-selected static delivery contract, not an official SDK requirement or
 * proof of host compatibility. Never import or execute the TUI entrypoint here.
 * The host loads the exports["."] source (src/index.ts -> src/tui.tsx), which
 * statically imports @opentui/core, @opentui/solid/jsx-runtime and solid-js.
 * They are therefore declared as peerDependencies pinned to the host version
 * (matching the working reference opencode-db-insight): npm >=7 auto-installs
 * peers, so a clean `npm install` from a git spec hoists the host's
 * @opentui@0.8.0 / solid-js@1.9.17 and they resolve. Without them a clean
 * install fails in the real host ("Cannot find package '@opentui/solid'").
 * Even so, passing tests still require validation in the real host.
 */
import { expect, test } from "bun:test"
import { existsSync, readFileSync } from "node:fs"
import { dirname, isAbsolute, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { Host } from "@opencode/plugin/host"

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url))
const packageManifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
  exports?: Record<string, string>
  dependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
  optionalDependencies?: Record<string, string>
}
const expectedTuiExport = "./dist/tui.js"
const artifactPath = resolve(repositoryRoot, expectedTuiExport)

function readArtifact(): string {
  expect(existsSync(artifactPath)).toBe(true)
  return readFileSync(artifactPath, "utf8")
}

/**
 * The stamp exists so "the host is running old code" can be proven rather than
 * suspected. It records the sha256 of the exact dist/tui.js bytes that were
 * built; any hand edit, stale rebuild or git checkout drift makes the delivery
 * step refuse the artifact instead of quietly loading the wrong version.
 * Run `node scripts/stamp-build.mjs` (build:tui already does) after building.
 */
test("delivered bundle matches its build stamp", () => {
  const stampPath = resolve(repositoryRoot, "dist/build-stamp.json")
  expect(existsSync(stampPath)).toBe(true)
  const stamp = JSON.parse(readFileSync(stampPath, "utf8")) as {
    sha256?: string
    bytes?: number
    builtAt?: string
    commit?: string
  }
  // Bun.hash is not sha256; hash the bytes through node:crypto for parity.
  const artifactBytes = readFileSync(artifactPath)
  const { createHash } = require("node:crypto") as typeof import("node:crypto")
  const artifactSha256 = createHash("sha256").update(artifactBytes).digest("hex")
  expect(stamp.sha256).toBe(artifactSha256)
  expect(stamp.bytes).toBe(artifactBytes.length)
  expect(typeof stamp.builtAt).toBe("string")
  expect(Number.isNaN(Date.parse(stamp.builtAt!))).toBe(false)
  // "nogit" is a legitimate value outside a checkout; an empty one is not.
  expect(typeof stamp.commit).toBe("string")
  expect(stamp.commit!.length).toBeGreaterThan(0)
})

test("published TUI export and directory-based Host.resolve forward to the same bundle", () => {
  expect(packageManifest.exports?.["./tui"]).toBe(expectedTuiExport)
  expect(Host.resolve({ directory: repositoryRoot }).tui).toBeDefined()
  const hostTuiPath = fileURLToPath(Host.resolve({ directory: repositoryRoot }).tui!)
  expect(resolve(hostTuiPath)).toBe(resolve(repositoryRoot, "tui.js"))
  // Accept only a single default re-export, not an entry that executes local code.
  const forwardingSource = readFileSync(hostTuiPath, "utf8")
  const defaultReexport = forwardingSource.match(/^\s*export\s*\{\s*default\s*\}\s*from\s*["'](\.\/[^"']+)["']\s*;?\s*$/)
  expect(defaultReexport).not.toBeNull()
  expect(resolve(dirname(hostTuiPath), defaultReexport![1])).toBe(artifactPath)
  expect(existsSync(artifactPath)).toBe(true)
})

test("project delivery strategy: declare OpenTUI/Solid peers so a clean git install hoists the host copies", () => {
  // The host loads the exports["."] source (src/index.ts -> src/tui.tsx), which
  // statically imports @opentui/core, @opentui/solid/jsx-runtime and solid-js.
  // Without peerDependencies a clean `npm install` from a git spec cannot resolve
  // them (real-host log: "Cannot find package '@opentui/solid'"). db-insight is the
  // working reference: it declares these as peerDependencies pinned to the host version.
  expect(packageManifest.peerDependencies?.["@opentui/core"]).toBe("0.8.0")
  expect(packageManifest.peerDependencies?.["@opentui/solid"]).toBe("0.8.0")
  expect(packageManifest.peerDependencies?.["solid-js"]).toBe("1.9.17")
  // They must not be regular dependencies: that would pull a second OpenTUI instance
  // and break instanceof/symbol identity with the host's copy.
  expect(packageManifest.dependencies?.["@opentui/core"]).toBeUndefined()
  expect(packageManifest.dependencies?.["@opentui/solid"]).toBeUndefined()
  expect(packageManifest.dependencies?.["solid-js"]).toBeUndefined()
  // The host provides @opencode/plugin; fuzzysort is a source runtime import so it
  // must be a regular dependency for the source entry to resolve it.
  expect(packageManifest.devDependencies?.["@opencode/plugin"]).toBeDefined()
  expect(packageManifest.dependencies?.["fuzzysort"]).toBeDefined()
})

test("delivered JS keeps host modules external and bundles local business modules", () => {
  const artifactSource = readArtifact()
  // Import syntax alone does not prove that the real host resolves these to
  // its own module instances; that remains an integration/real-host check.
  // Bun's JS parser reports actual import specifiers, not incidental strings or comments.
  const importedModules = new Bun.Transpiler({ loader: "js" }).scanImports(artifactSource)
  const importSpecifiers = importedModules.map((importedModule) => importedModule.path)
  const requiredHostImports = ["@opentui/core", "@opentui/solid/jsx-runtime", "@opencode/plugin/tui"]
  for (const requiredImport of requiredHostImports) expect(importSpecifiers).toContain(requiredImport)
  expect(importSpecifiers.length).toBeGreaterThanOrEqual(requiredHostImports.length)
  for (const specifier of importSpecifiers) {
    expect(specifier.startsWith(".") || isAbsolute(specifier) || /^[A-Za-z]:[\\/]/.test(specifier)).toBe(false)
    expect(
      specifier.startsWith("node:") ||
        specifier.startsWith("bun:") ||
        specifier.startsWith("@opencode/plugin/") ||
        specifier.startsWith("@opentui/") ||
        specifier === "solid-js" ||
        specifier.startsWith("solid-js/"),
    ).toBe(true)
  }

  // These are runtime function definitions from separate local modules; an entry-only
  // re-export is not a deliverable standalone bundle. Not a byte-for-byte freshness test.
  for (const businessFunction of ["createHistorySource", "createSuggestionStore", "createGhostLine", "registerKeymap"]) {
    expect(artifactSource).toMatch(new RegExp(`\\bfunction\\s+${businessFunction}\\s*\\(`))
  }
  expect(artifactSource).toMatch(/export\s*\{[^}]*\bas\s+default\b[^}]*\}/)
})

test("delivered JS contains no bundled OpenTUI registry or local node_modules paths", () => {
  const artifactSource = readArtifact()
  expect(artifactSource).not.toContain("OPENTUI_FORCE_UNICODE")
  expect(artifactSource).not.toContain("already registered with different configuration")
  expect(artifactSource).not.toMatch(/(?:[A-Za-z]:[\\/]|file:\/\/|\/)(?:[^\s"'`]*[\\/])?node_modules[\\/]/)
})
