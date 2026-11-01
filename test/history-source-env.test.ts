/** DB-path resolution tests (DESIGN §3.1, history-source.ts).
 *
 * Task 1 — OPENCODE_DB env override wins over dataDirOverride and the default
 *   directory when it is set to an absolute path (resolveDatabaseFilePath
 *   returns process.env["OPENCODE_DB"] before any directory scan).
 * Task 2 — findNewestDatabaseInDirectory: when no opencode.db exists, the
 *   newest opencode*.db by mtime is selected, and the "no matching file → no DB
 *   at all (jsonl-only)" branch yields an empty DB source.
 *
 * Both tasks exercise real bun:sqlite through createHistorySource. They run in
 * an isolated child Bun process (the same pattern as history-completeness /
 * history-scan-performance) so a mock.module of history-source in another
 * suite file cannot leak into this one. Every fixture is synthetic.
 */
import * as nodeFs from "node:fs"
import * as nodeOs from "node:os"
import * as nodePath from "node:path"
import { spawn } from "node:child_process"
import { fileURLToPath } from "node:url"
import { Database } from "bun:sqlite"
import { test } from "bun:test"
import { createHistorySource } from "../src/history-source"

function assert(condition: boolean, description: string): void {
  if (!condition) throw new Error(description)
}

function assertTexts(entries: Array<{ text: string }>, expectedTexts: string[], description: string): void {
  assert(
    JSON.stringify(entries.map((entry) => entry.text)) === JSON.stringify(expectedTexts),
    `${description} (expected ${JSON.stringify(expectedTexts)}, got ${JSON.stringify(entries.map((entry) => entry.text))})`,
  )
}

/** Creates a read-only history DB containing exactly the given V2 user texts. */
function createDatabaseWithTexts(databasePath: string, texts: string[]): void {
  const database = new Database(databasePath)
  database.exec("CREATE TABLE session_message (id TEXT PRIMARY KEY, type TEXT, data TEXT, time_created INTEGER)")
  for (let textIndex = 0; textIndex < texts.length; textIndex += 1) {
    database.run("INSERT INTO session_message VALUES (?, 'user', ?, ?)", [
      `entry-${textIndex}`, JSON.stringify({ text: texts[textIndex] }), 10_000 - textIndex,
    ])
  }
  database.close()
}

async function removeTreeWithRetry(directory: string): Promise<void> {
  for (let cleanupAttempt = 0; cleanupAttempt < 10; cleanupAttempt += 1) {
    try {
      nodeFs.rmSync(directory, { recursive: true, force: true })
      return
    } catch (cleanupError) {
      if (cleanupAttempt === 9) throw cleanupError
      await Bun.sleep(25)
    }
  }
}

async function runEnvOverrideFixture(): Promise<void> {
  const fixtureDirectory = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), "history-env-"))

  // The env override points at its own DB (known content), while dataDirOverride
  // points at a DIFFERENT directory containing a DIFFERENT known DB. Env must win.
  const envDirectory = nodePath.join(fixtureDirectory, "env-db")
  const dataDirDirectory = nodePath.join(fixtureDirectory, "data-dir-db")
  nodeFs.mkdirSync(envDirectory)
  nodeFs.mkdirSync(dataDirDirectory)
  const envDatabasePath = nodePath.join(envDirectory, "opencode.db")
  const dataDirDatabasePath = nodePath.join(dataDirDirectory, "opencode.db")
  createDatabaseWithTexts(envDatabasePath, ["env source text"])
  createDatabaseWithTexts(dataDirDatabasePath, ["dataDir source text"])

  const previousDatabaseOverride = process.env["OPENCODE_DB"]
  try {
    // Absolute env path: this must win over dataDirOverride.
    process.env["OPENCODE_DB"] = envDatabasePath
    const envSource = createHistorySource({ dataDirOverride: dataDirDirectory, maxEntries: 4 })
    await envSource.whenReady()
    assertTexts(envSource.entries(), ["env source text"], "OPENCODE_DB absolute path wins over dataDirOverride")

    // A whitespace-only env value is treated as absent, so dataDirOverride wins.
    process.env["OPENCODE_DB"] = "   "
    const blankSource = createHistorySource({ dataDirOverride: dataDirDirectory, maxEntries: 4 })
    await blankSource.whenReady()
    assertTexts(blankSource.entries(), ["dataDir source text"], "blank OPENCODE_DB falls back to dataDirOverride")
    console.log("PASS history source OPENCODE_DB env override (env wins, blank env falls back)")
  } finally {
    if (previousDatabaseOverride === undefined) delete process.env["OPENCODE_DB"]
    else process.env["OPENCODE_DB"] = previousDatabaseOverride
    await removeTreeWithRetry(fixtureDirectory)
  }
}

async function runNewestWildcardFixture(): Promise<void> {
  const fixtureDirectory = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), "history-newest-"))

  // NO opencode.db in this directory — only opencode-server.db (older mtime)
  // and opencode-cli.db (newer mtime), with DIFFERENT known content. The newest
  // by mtime (cli) must be selected and its content must be the ONLY history.
  const serverDatabasePath = nodePath.join(fixtureDirectory, "opencode-server.db")
  const cliDatabasePath = nodePath.join(fixtureDirectory, "opencode-cli.db")
  createDatabaseWithTexts(serverDatabasePath, ["server db text"])
  createDatabaseWithTexts(cliDatabasePath, ["cli db text"])
  // Deterministically make cli newer: explicit mtimes, clearly separated.
  const olderTime = new Date("2020-01-01T00:00:00Z")
  const newerTime = new Date("2030-01-01T00:00:00Z")
  nodeFs.utimesSync(serverDatabasePath, olderTime, olderTime)
  nodeFs.utimesSync(cliDatabasePath, newerTime, newerTime)

  const previousDatabaseOverride = process.env["OPENCODE_DB"]
  try {
    delete process.env["OPENCODE_DB"]
    const source = createHistorySource({ dataDirOverride: fixtureDirectory, maxEntries: 4 })
    await source.whenReady()
    assertTexts(source.entries(), ["cli db text"], "newest opencode*.db by mtime is selected when opencode.db is absent")
    assert(source.readStats().databaseLoads === 1, "newest-wildcard selection still loads exactly one DB")
    console.log("PASS history source newest opencode*.db wildcard selection (cli newer than server)")
  } finally {
    if (previousDatabaseOverride === undefined) delete process.env["OPENCODE_DB"]
    else process.env["OPENCODE_DB"] = previousDatabaseOverride
    await removeTreeWithRetry(fixtureDirectory)
  }
}

async function runNoMatchBranchFixture(): Promise<void> {
  const fixtureDirectory = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), "history-nomatch-"))

  // No opencode*.db at all — only a prompt-history.jsonl. findNewestDatabaseInDirectory
  // must return null and the source must fall back to jsonl-only (no crash).
  nodeFs.writeFileSync(
    nodePath.join(fixtureDirectory, "prompt-history.jsonl"),
    `${JSON.stringify({ text: "jsonl only text" })}\n`,
  )

  const previousDatabaseOverride = process.env["OPENCODE_DB"]
  try {
    delete process.env["OPENCODE_DB"]
    const source = createHistorySource({ dataDirOverride: fixtureDirectory, maxEntries: 4 })
    await source.whenReady()
    assertTexts(source.entries(), ["jsonl only text"], "no matching opencode*.db degrades to jsonl-only without crash")
    assert(source.readStats().databaseLoads === 0, "no matching DB file means zero database loads")
    console.log("PASS history source no-matching-DB branch degrades to jsonl-only")
  } finally {
    if (previousDatabaseOverride === undefined) delete process.env["OPENCODE_DB"]
    else process.env["OPENCODE_DB"] = previousDatabaseOverride
    await removeTreeWithRetry(fixtureDirectory)
  }
}

if (process.argv.includes("--history-source-env-child")) {
  await runEnvOverrideFixture()
  await runNewestWildcardFixture()
  await runNoMatchBranchFixture()
} else {
  const runIsolated = async (): Promise<void> => {
    const testFilePath = fileURLToPath(import.meta.url)
    await new Promise<void>((resolve, reject) => {
      const isolatedRun = spawn(process.execPath, [testFilePath, "--history-source-env-child"], {
        stdio: ["ignore", "pipe", "pipe"],
      })
      let standardOutput = ""
      let standardError = ""
      isolatedRun.stdout.setEncoding("utf8")
      isolatedRun.stderr.setEncoding("utf8")
      isolatedRun.stdout.on("data", (chunk: string) => { standardOutput += chunk })
      isolatedRun.stderr.on("data", (chunk: string) => { standardError += chunk })
      isolatedRun.once("error", reject)
      isolatedRun.once("close", (exitCode, signal) => {
        if (exitCode !== 0) {
          reject(new Error(`Isolated history-source env/newest fixture failed (exit=${String(exitCode)}, signal=${String(signal)}):\n${standardOutput}\n${standardError}`))
          return
        }
        process.stdout.write(standardOutput)
        resolve()
      })
    })
  }
  try {
    test("history-source DB path resolution (env override + newest wildcard + no-match)", runIsolated, 60_000)
  } catch (registrationError) {
    if (!(registrationError instanceof Error) || !registrationError.message.includes("Cannot use test outside of the test runner")) throw registrationError
    await runEnvOverrideFixture()
    await runNewestWildcardFixture()
    await runNoMatchBranchFixture()
  }
}