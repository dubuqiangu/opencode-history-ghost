import * as nodeFs from "node:fs"
import * as nodeOs from "node:os"
import * as nodePath from "node:path"
import { spawn } from "node:child_process"
import { fileURLToPath } from "node:url"
import { Database } from "bun:sqlite"
import { test } from "bun:test"
import { createHistorySource, type HistoryEntry } from "../src/history-source"
import { createSuggestionStore, type HistoryGhostSettings } from "../src/suggestion-store"

function assert(condition: boolean, description: string): void {
  if (!condition) throw new Error(description)
}

function assertTexts(actualEntries: HistoryEntry[], expectedTexts: string[], description: string): void {
  assert(JSON.stringify(actualEntries.map((entry) => entry.text)) === JSON.stringify(expectedTexts), description)
}

async function runIsolatedFixture(): Promise<void> {
  const fixtureDirectory = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), "history-completeness-"))
  const previousDatabaseOverride = process.env["OPENCODE_DB"]
  delete process.env["OPENCODE_DB"]

  try {
  const databasePath = nodePath.join(fixtureDirectory, "opencode.db")
  const database = new Database(databasePath)
  database.exec(`
    CREATE TABLE session_message (id TEXT PRIMARY KEY, type TEXT, data TEXT, time_created INTEGER);
    CREATE TABLE message (id TEXT PRIMARY KEY, data TEXT, time_created INTEGER);
    CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, data TEXT);
  `)
  const insertSession = (entryId: string, entryData: string, createdAt: number): void => {
    database.run("INSERT INTO session_message VALUES (?, 'user', ?, ?)", [entryId, entryData, createdAt])
  }
  const insertMessage = (entryId: string, entryData: string, createdAt: number): void => {
    database.run("INSERT INTO message VALUES (?, ?, ?)", [entryId, entryData, createdAt])
  }
  const insertPart = (entryId: string, messageId: string, entryData: string): void => {
    database.run("INSERT INTO part VALUES (?, ?, ?)", [entryId, messageId, entryData])
  }
  // More than one batch of recent rows are invalid/duplicate; valid entries occur below them.
  for (let rowIndex = 0; rowIndex < 600; rowIndex += 1) {
    const text = rowIndex % 3 === 0 ? "/ignored" : rowIndex % 3 === 1 ? "repeat" : "x"
    insertSession(`recent-${rowIndex}`, JSON.stringify({ text }), 10000 - rowIndex)
  }
  insertSession("older-one", JSON.stringify({ text: "older one" }), 8000)
  insertSession("older-two", JSON.stringify({ parts: [{ text: "older " }, { text: "two" }] }), 7999)
  insertSession("invalid-json", "{", 7998)
  for (let rowIndex = 0; rowIndex < 300; rowIndex += 1) {
    const messageId = `legacy-recent-${rowIndex}`
    insertMessage(messageId, JSON.stringify({ role: "user" }), 10000 - rowIndex)
    insertPart(`part-${messageId}`, messageId, JSON.stringify({ type: "text", text: rowIndex % 2 ? "/ignored" : "repeat" }))
  }
  insertMessage("legacy-duplicate", JSON.stringify({ role: "user" }), 9000)
  insertPart("part-duplicate", "legacy-duplicate", JSON.stringify({ type: "text", text: "repeat" }))
  insertMessage("legacy-exclusive", JSON.stringify({ role: "user" }), 8999)
  insertPart("part-exclusive", "legacy-exclusive", JSON.stringify({ type: "text", text: "legacy only" }))
  insertMessage("legacy-lower", JSON.stringify({ role: "user" }), 8998)
  insertPart("part-lower", "legacy-lower", JSON.stringify({ type: "text", text: "legacy lower" }))
  database.close()

  nodeFs.writeFileSync(nodePath.join(fixtureDirectory, "prompt-history.jsonl"), [
    JSON.stringify({ text: "older one" }),
    JSON.stringify({ text: "jsonl newest" }),
  ].join("\n") + "\n")

  // Six distinct valid entries (two from jsonl, two V2-only, two legacy-only):
  // maxEntries=7 cannot be filled by V2, so legacy must be read to reach six.
  const fullSource = createHistorySource({ dataDirOverride: fixtureDirectory, maxEntries: 7 })
  await fullSource.whenReady()
  assertTexts(fullSource.entries(), ["jsonl newest", "older one", "repeat", "older two", "legacy only", "legacy lower"], "merge both tables after filtering and deduplication, jsonl first")
  const boundarySource = createHistorySource({ dataDirOverride: fixtureDirectory, maxEntries: 3 })
  await boundarySource.whenReady()
  assertTexts(boundarySource.entries(), ["jsonl newest", "older one", "repeat"], "limit applies to valid unique merged entries")
  const zeroSource = createHistorySource({ dataDirOverride: fixtureDirectory, maxEntries: 0 })
  await zeroSource.whenReady()
  assertTexts(zeroSource.entries(), [], "zero limit yields no entries")
  const oneSource = createHistorySource({ dataDirOverride: fixtureDirectory, maxEntries: 1 })
  await oneSource.whenReady()
  assertTexts(oneSource.entries(), ["jsonl newest"], "one-entry boundary retains jsonl priority")

  // High cross-source overlap: a DB cache of N unique texts is enough to
  // fill the merged N slots. If jsonl contributes j entries, at most j DB
  // entries overlap them, leaving at least N-j DB entries for the open slots.
  const overlapDirectory = nodePath.join(fixtureDirectory, "high-overlap")
  nodeFs.mkdirSync(overlapDirectory)
  const overlapPath = nodePath.join(overlapDirectory, "prompt-history.jsonl")
  const overlapDatabase = new Database(nodePath.join(overlapDirectory, "opencode.db"))
  overlapDatabase.exec(`
    CREATE TABLE session_message (id TEXT PRIMARY KEY, type TEXT, data TEXT, time_created INTEGER);
    CREATE TABLE message (id TEXT PRIMARY KEY, data TEXT, time_created INTEGER);
    CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, data TEXT);
  `)
  for (let entryIndex = 0; entryIndex < 4; entryIndex++) {
    overlapDatabase.run("INSERT INTO session_message VALUES (?, 'user', ?, ?)", [
      `overlap-${entryIndex}`, JSON.stringify({ text: `shared item ${entryIndex}` }), 100 - entryIndex,
    ])
  }
  overlapDatabase.run("INSERT INTO session_message VALUES ('db-exclusive', 'user', ?, 90)", [JSON.stringify({ text: "older db only" })])
  overlapDatabase.run("INSERT INTO session_message VALUES ('deep-exclusive', 'user', ?, 89)", [JSON.stringify({ text: "deep db only" })])
  overlapDatabase.close()
  const initialJsonl = ["shared item 3", "shared item 2", "shared item 1", "shared item 0"]
  nodeFs.writeFileSync(overlapPath, initialJsonl.map((text) => JSON.stringify({ text })).join("\n") + "\n")
  const overlapSource = createHistorySource({ dataDirOverride: overlapDirectory, maxEntries: 5 })
  await overlapSource.whenReady()
  assertTexts(overlapSource.entries(), ["shared item 0", "shared item 1", "shared item 2", "shared item 3", "older db only"], "initial high-overlap merge reaches older DB-only row")

  // V2 and legacy overlap after trimming and line-ending normalization;
  // legacy must still be paged until enough new unique entries are found.
  const mixedDirectory = nodePath.join(fixtureDirectory, "mixed-tables")
  nodeFs.mkdirSync(mixedDirectory)
  const mixedDatabase = new Database(nodePath.join(mixedDirectory, "opencode.db"))
  mixedDatabase.exec(`
    CREATE TABLE session_message (id TEXT PRIMARY KEY, type TEXT, data TEXT, time_created INTEGER);
    CREATE TABLE message (id TEXT PRIMARY KEY, data TEXT, time_created INTEGER);
    CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, data TEXT);
  `)
  for (let entryIndex = 0; entryIndex < 3; entryIndex++) {
    mixedDatabase.run("INSERT INTO session_message VALUES (?, 'user', ?, ?)", [
      `v2-${entryIndex}`, JSON.stringify({ text: `v2 item ${entryIndex}` }), 100 - entryIndex,
    ])
  }
  for (const [entryIndex, text] of [" v2 item 0 ", "v2 item 1", "legacy item 0", "legacy item 1", "legacy item 2"].entries()) {
    const messageId = `legacy-${entryIndex}`
    mixedDatabase.run("INSERT INTO message VALUES (?, ?, ?)", [messageId, JSON.stringify({ role: "user" }), 100 - entryIndex])
    mixedDatabase.run("INSERT INTO part VALUES (?, ?, ?)", [`part-${entryIndex}`, messageId, JSON.stringify({ type: "text", text })])
  }
  mixedDatabase.close()
  nodeFs.writeFileSync(nodePath.join(mixedDirectory, "prompt-history.jsonl"), `${JSON.stringify({ text: "v2 item 0" })}\n`)
  const mixedSource = createHistorySource({ dataDirOverride: mixedDirectory, maxEntries: 6 })
  await mixedSource.whenReady()
  assertTexts(mixedSource.entries(), ["v2 item 0", "v2 item 1", "v2 item 2", "legacy item 0", "legacy item 1", "legacy item 2"], "deduplicate across jsonl, V2 and legacy, then fill with legacy uniques")
  const mixedZeroSource = createHistorySource({ dataDirOverride: mixedDirectory, maxEntries: 0 })
  await mixedZeroSource.whenReady()
  assertTexts(mixedZeroSource.entries(), [], "mixed-table zero-entry limit never pages")
  const mixedOneSource = createHistorySource({ dataDirOverride: mixedDirectory, maxEntries: 1 })
  await mixedOneSource.whenReady()
  assertTexts(mixedOneSource.entries(), ["v2 item 0"], "mixed-table one-entry limit honors jsonl precedence")

  const emptyDirectory = nodePath.join(fixtureDirectory, "empty-database")
  nodeFs.mkdirSync(emptyDirectory)
  const emptyDatabase = new Database(nodePath.join(emptyDirectory, "opencode.db"))
  emptyDatabase.exec(`
    CREATE TABLE session_message (id TEXT PRIMARY KEY, type TEXT, data TEXT, time_created INTEGER);
    CREATE TABLE message (id TEXT PRIMARY KEY, data TEXT, time_created INTEGER);
    CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, data TEXT);
  `)
  emptyDatabase.close()
  const emptySource = createHistorySource({ dataDirOverride: emptyDirectory, maxEntries: 4 })
  await emptySource.whenReady()
  assertTexts(emptySource.entries(), [], "empty read-only SQLite tables yield no entries")
  assert(emptySource.readStats().databaseLoads === 1, "empty SQLite schema is loaded without fallback")

  // A newly arrived jsonl history can also overlap previously cached DB rows.
  const refreshDirectory = nodePath.join(fixtureDirectory, "refresh-overlap")
  nodeFs.mkdirSync(refreshDirectory)
  const refreshPath = nodePath.join(refreshDirectory, "prompt-history.jsonl")
  const refreshDatabase = new Database(nodePath.join(refreshDirectory, "opencode.db"))
  refreshDatabase.exec("CREATE TABLE session_message (id TEXT PRIMARY KEY, type TEXT, data TEXT, time_created INTEGER)")
  for (let entryIndex = 0; entryIndex < 8; entryIndex++) {
    refreshDatabase.run("INSERT INTO session_message VALUES (?, 'user', ?, ?)", [
      `db-${entryIndex}`, JSON.stringify({ text: `db item ${entryIndex}` }), 100 - entryIndex,
    ])
  }
  refreshDatabase.close()
  nodeFs.writeFileSync(refreshPath, "")
  const refreshSource = createHistorySource({ dataDirOverride: refreshDirectory, maxEntries: 4 })
  await refreshSource.whenReady()
  assertTexts(refreshSource.entries(), ["db item 0", "db item 1", "db item 2", "db item 3"], "DB-only initialization respects limit")
  const entriesBeforeRefresh = refreshSource.entries()
  refreshSource.refresh()
  assert(refreshSource.entries() === entriesBeforeRefresh, "unchanged jsonl keeps the entries array reference")
  nodeFs.writeFileSync(refreshPath, ["db item 3", "db item 2", "db item 1"].map((text) => JSON.stringify({ text })).join("\n") + "\n")
  const changedTime = new Date(Date.now() + 2000)
  nodeFs.utimesSync(refreshPath, changedTime, changedTime)
  const readsBeforeRefresh = refreshSource.readStats()
  refreshSource.refresh()
  assert(refreshSource.readStats().jsonlReads === readsBeforeRefresh.jsonlReads + 1 && refreshSource.readStats().databaseLoads === readsBeforeRefresh.databaseLoads, "mtime refresh rereads only jsonl")
  assertTexts(refreshSource.entries(), ["db item 1", "db item 2", "db item 3", "db item 0"], "refresh overlap preserves jsonl order and fills from DB cache")
  const entriesAfterRefresh = refreshSource.entries()
  assert(entriesAfterRefresh !== entriesBeforeRefresh, "changed ordering replaces entries array reference")
  nodeFs.writeFileSync(refreshPath, ["db item 3", "db item 2", "db item 1"].map((text) => JSON.stringify({ text })).join("\n") + "\n\n")
  nodeFs.utimesSync(refreshPath, new Date(changedTime.getTime() + 2000), new Date(changedTime.getTime() + 2000))
  refreshSource.refresh()
  assert(refreshSource.entries() === entriesAfterRefresh, "mtime change without candidate changes keeps the entries array reference")

  const legacyOnlyDirectory = nodePath.join(fixtureDirectory, "legacy-only")
  nodeFs.mkdirSync(legacyOnlyDirectory)
  const legacyDatabase = new Database(nodePath.join(legacyOnlyDirectory, "opencode.db"))
  legacyDatabase.exec("CREATE TABLE message (id TEXT, data TEXT, time_created INTEGER); CREATE TABLE part (message_id TEXT, data TEXT)")
  legacyDatabase.run("INSERT INTO message VALUES ('legacy-entry', ?, 1)", [JSON.stringify({ role: "user" })])
  legacyDatabase.run("INSERT INTO part VALUES ('legacy-entry', ?)", [JSON.stringify({ type: "text", text: "legacy standalone" })])
  legacyDatabase.close()
  const legacyOnlySource = createHistorySource({ dataDirOverride: legacyOnlyDirectory, maxEntries: 2 })
  await legacyOnlySource.whenReady()
  assertTexts(legacyOnlySource.entries(), ["legacy standalone"], "missing V2 table falls back to legacy")

  const settings: HistoryGhostSettings = {
    enabled: true, acceptKey: "tab", minChars: 3, maxCandidates: 5,
    maxEntries: 10, maxTextLength: 2000, excludePrefixes: ["/", "@"],
  }
  const store = createSuggestionStore(() => ["hello", "hello world"].map((text) => ({ text, lower: text.toLowerCase() })), settings)
  store.evaluate("hel")
  const initialCandidates = store.state()?.candidates
  store.evaluate("hell")
  assert(store.state()?.candidates === initialCandidates, "proper extension retains candidate array reference")
  store.evaluate("hello")
  assert(store.current()?.text === "hello world", "exactly matched shown candidate is excluded and another candidate chosen")
  store.evaluate("hello world")
  assert(store.state() === null, "extending to the exact last candidate clears the suggestion")
  store.evaluate("hel")
  store.cycle(1)
  const cycledCandidates = store.state()?.candidates
  store.evaluate("hell")
  assert(store.state()?.candidates === cycledCandidates && store.state()?.index === 1, "cycle index and array remain stable during proper extension")
  store.evaluate("hello world")
  assert(store.state() === null, "when cycled candidate becomes exact, recompute and clear if nothing else matches")
  console.log("PASS history completeness and suggestion exact-match regression")
  } finally {
  if (previousDatabaseOverride === undefined) delete process.env["OPENCODE_DB"]
  else process.env["OPENCODE_DB"] = previousDatabaseOverride
  // Windows Bun SQLite may release the file handle after the current microtask.
  for (let cleanupAttempt = 0; cleanupAttempt < 10; cleanupAttempt += 1) {
    try {
      nodeFs.rmSync(fixtureDirectory, { recursive: true, force: true })
      break
    } catch (cleanupError) {
      if (cleanupAttempt === 9) throw cleanupError
      await Bun.sleep(25)
    }
  }
  }
}

// Bun's mock.module in ghost-core replaces the shared history-source module for
// other files in a single `bun test` invocation. A fresh Bun process is the
// isolation boundary: no resets, no fallback mocks, and the real SQLite source
// (including whenReady) is exercised. The parent test fails on child failure.
if (process.argv.includes("--history-completeness-child")) {
  await runIsolatedFixture()
} else {
  const runInIsolatedProcess = async (): Promise<void> => {
    const testFilePath = fileURLToPath(import.meta.url)
    await new Promise<void>((resolve, reject) => {
      const isolatedRun = spawn(process.execPath, [testFilePath, "--history-completeness-child"], {
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
          reject(new Error(`Isolated history fixture failed (exit=${String(exitCode)}, signal=${String(signal)}):\n${standardOutput}\n${standardError}`))
          return
        }
        process.stdout.write(standardOutput)
        resolve()
      })
    })
  }
  try {
    test("real SQLite history completeness and suggestion exact match", runInIsolatedProcess, 30_000)
  } catch (registrationError) {
    // `bun test/history-completeness.test.ts` executes as a script rather than
    // through the test runner. It must still run the same real fixture and fail
    // on any assertion, not silently register zero tests.
    if (!(registrationError instanceof Error) || !registrationError.message.includes("Cannot use test outside of the test runner")) {
      throw registrationError
    }
    await runIsolatedFixture()
  }
}
