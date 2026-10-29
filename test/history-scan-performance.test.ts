import * as nodeFs from "node:fs"
import * as nodeOs from "node:os"
import * as nodePath from "node:path"
import { spawn } from "node:child_process"
import { fileURLToPath } from "node:url"
import { Database } from "bun:sqlite"
import { test } from "bun:test"
import { createHistorySource } from "../src/history-source"

function assertScan(condition: boolean, description: string): void {
  if (!condition) throw new Error(description)
}

/** Exercise the NULL-time continuation after hundreds of pages, not merely
 * the transition into its first page. All content is synthetic. */
async function runNullTimeSeekFixture(): Promise<void> {
  const fixtureDirectory = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), "history-null-time-seek-"))
  const previousDatabaseOverride = process.env["OPENCODE_DB"]
  delete process.env["OPENCODE_DB"]
  try {
    const databasePath = nodePath.join(fixtureDirectory, "opencode.db")
    const database = new Database(databasePath)
    database.exec(`
      CREATE TABLE message (id TEXT PRIMARY KEY, data TEXT, time_created INTEGER);
      CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, data TEXT);
      CREATE INDEX message_time ON message(time_created DESC);
      CREATE INDEX part_message ON part(message_id);
    `)
    const insertMessage = database.prepare("INSERT INTO message VALUES (?, ?, ?)")
    const insertPart = database.prepare("INSERT INTO part VALUES (?, ?, ?)")
    const rowCount = 60_000
    const userRole = JSON.stringify({ role: "user" })
    const duplicatePart = JSON.stringify({ type: "text", text: "repeat" })
    const ignoredPart = JSON.stringify({ type: "text", text: "/skip" })
    database.exec("BEGIN")
    insertMessage.run("oldest-null", userRole, null)
    insertPart.run("oldest-part", "oldest-null", JSON.stringify({ type: "text", text: "null oldest unique" }))
    for (let messageIndex = 0; messageIndex < rowCount; messageIndex++) {
      const messageId = `null-message-${messageIndex}`
      insertMessage.run(messageId, userRole, null)
      insertPart.run(`duplicate-${messageIndex}`, messageId, duplicatePart)
      insertPart.run(`ignored-${messageIndex}`, messageId, ignoredPart)
    }
    database.exec("COMMIT")
    insertMessage.finalize(); insertPart.finalize()
    database.close()

    const readOnlyDatabase = new Database(databasePath, { readonly: true })
    const referenceStatement = readOnlyDatabase.prepare(`SELECT message.rowid AS messageRowId, part.rowid AS partRowId FROM message
      JOIN part ON part.message_id = message.id WHERE message.time_created IS NULL AND message.data LIKE '%"role":"user"%'
      ORDER BY message.time_created DESC, message.rowid DESC, part.rowid DESC LIMIT ? OFFSET ?`)
    const referenceCursor = referenceStatement.all(1, 20_000)[0]
    assertScan(referenceCursor !== undefined, "synthetic NULL-time cursor exists")
    const seekSql = `SELECT message.rowid AS messageRowId, part.rowid AS partRowId FROM message
      JOIN part ON part.message_id = message.id WHERE message.time_created IS NULL AND
      (message.rowid, part.rowid) < (?, ?) AND message.data LIKE '%"role":"user"%'
      ORDER BY message.time_created DESC, message.rowid DESC, part.rowid DESC LIMIT ?`
    const referenceNext = referenceStatement.all(5, 20_001)
    const seekStatement = readOnlyDatabase.prepare(seekSql)
    const actualNext = seekStatement.all(referenceCursor.messageRowId, referenceCursor.partRowId, 5)
    assertScan(JSON.stringify(actualNext) === JSON.stringify(referenceNext), "NULL-time tuple seek matches OFFSET across a same-message multipart boundary")
    const planStatement = readOnlyDatabase.prepare(`EXPLAIN QUERY PLAN ${seekSql}`)
    const queryPlan = planStatement.all(referenceCursor.messageRowId, referenceCursor.partRowId, 256)
    assertScan(queryPlan.some((planRow) => typeof planRow.detail === "string" &&
      /SEARCH message USING (?:COVERING )?INDEX message_time \(time_created=\? AND rowid<\?\)/.test(planRow.detail)),
      "NULL-time continuation constrains the indexed message rowid rather than scanning all NULL-time messages")
    referenceStatement.finalize(); seekStatement.finalize(); planStatement.finalize()
    readOnlyDatabase.close()

    const scanStart = performance.now()
    const source = createHistorySource({ dataDirOverride: fixtureDirectory, maxEntries: 2 })
    await source.whenReady()
    const scanElapsed = performance.now() - scanStart
    assertScan(JSON.stringify(source.entries().map((entry) => entry.text)) === JSON.stringify(["repeat", "null oldest unique"]), "full NULL-time pagination reaches older unique text after duplicate and filtered parts")
    assertScan(source.readStats().databaseLoads === 1, "NULL-time scan still counts one read-only DB load")
    console.log(`PASS synthetic NULL-time legacy seek: ${rowCount} messages, ${rowCount * 2 + 1} parts, complete scan ${scanElapsed.toFixed(1)}ms, indexed tuple seek matches OFFSET`)
  } finally {
    if (previousDatabaseOverride === undefined) delete process.env["OPENCODE_DB"]
    else process.env["OPENCODE_DB"] = previousDatabaseOverride
    for (let cleanupAttempt = 0; cleanupAttempt < 20; cleanupAttempt++) {
      try {
        nodeFs.rmSync(fixtureDirectory, { recursive: true, force: true })
        break
      } catch (cleanupError) {
        if (cleanupAttempt === 19) console.warn(`Synthetic fixture cleanup deferred (${String((cleanupError as Error).name)})`)
        else await Bun.sleep(100)
      }
    }
  }
}

async function runLargeSqliteFixture(): Promise<void> {
  const fixtureDirectory = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), "history-scan-performance-"))
  const previousDatabaseOverride = process.env["OPENCODE_DB"]
  delete process.env["OPENCODE_DB"]
  try {
    const database = new Database(nodePath.join(fixtureDirectory, "opencode.db"))
    database.exec(`
      CREATE TABLE session_message (id TEXT PRIMARY KEY, type TEXT, data TEXT, time_created INTEGER);
      CREATE TABLE message (id TEXT PRIMARY KEY, data TEXT, time_created INTEGER);
      CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, data TEXT);
      CREATE INDEX session_message_time ON session_message(time_created DESC);
      CREATE INDEX message_time ON message(time_created DESC);
      CREATE INDEX part_message ON part(message_id);
    `)
    const insertSession = database.prepare("INSERT INTO session_message VALUES (?, 'user', ?, ?)")
    const insertMessage = database.prepare("INSERT INTO message VALUES (?, ?, ?)")
    const insertPart = database.prepare("INSERT INTO part VALUES (?, ?, ?)")
    const recentRowCount = 104_000
    const legacyRowCount = 8_000
    database.exec("BEGIN")
    for (let rowIndex = 0; rowIndex < recentRowCount; rowIndex++) {
      const text = rowIndex % 3 === 0 ? "/skip" : rowIndex % 3 === 1 ? "repeat" : "x"
      insertSession.run(`session-${rowIndex}`, JSON.stringify({ text }), 1_000_000 - Math.floor(rowIndex / 3))
    }
    insertSession.run("v2-tail", JSON.stringify({ text: "v2 tail unique" }), null)
    for (let rowIndex = 0; rowIndex < legacyRowCount; rowIndex++) {
      const messageId = `legacy-${rowIndex}`
      insertMessage.run(messageId, JSON.stringify({ role: "user" }), 1_000_000 - Math.floor(rowIndex / 5))
      insertPart.run(`part-${rowIndex}`, messageId, JSON.stringify({ type: "text", text: rowIndex % 2 ? "repeat" : "/skip" }))
    }
    // A single message has >256 parts at the same timestamp, forcing the
    // legacy cursor to resume within one message (part.rowid tie-breaker).
    insertMessage.run("multipart-boundary", JSON.stringify({ role: "user" }), -1)
    for (let partIndex = 0; partIndex < 300; partIndex++) {
      insertPart.run(`multipart-${partIndex}`, "multipart-boundary", JSON.stringify({ type: "text", text: "repeat" }))
    }
    // NULL timestamp is last under DESC, but remains reachable after rows
    // with numeric timestamps; repeated parts must not skip the tail unique.
    insertMessage.run("legacy-tail", JSON.stringify({ role: "user" }), null)
    insertPart.run("tail-part-first", "legacy-tail", JSON.stringify({ type: "text", text: "v2 tail unique" }))
    insertPart.run("tail-part-second", "legacy-tail", JSON.stringify({ type: "text", text: "legacy tail unique" }))
    database.exec("COMMIT")
    insertSession.finalize(); insertMessage.finalize(); insertPart.finalize()
    database.close()

    // OFFSET baseline reports an observation only. It is deliberately never
    // used to impose a wall-clock threshold or touch actual user history.
    const baseline = new Database(nodePath.join(fixtureDirectory, "opencode.db"), { readonly: true })
    const baselineStatement = baseline.prepare("SELECT rowid FROM session_message WHERE type = 'user' ORDER BY time_created DESC, rowid DESC LIMIT ? OFFSET ?")
    const baselineStart = performance.now()
    let baselinePages = 0
    // Sample a bounded set of OFFSET positions rather than rerun the known
    // quadratic baseline for 400 pages on every CI machine.
    for (const rowOffset of [0, 256, 16_384, recentRowCount - 256]) {
      baselineStatement.all(256, rowOffset)
      baselinePages++
    }
    const baselineElapsedMs = performance.now() - baselineStart
    baselineStatement.finalize()
    baseline.close()

    // Failure after a successful page must roll back that source's partial
    // cache, then continue with legacy. Monkey-patch only this isolated Bun
    // fixture connection (never the user's SQLite connection or schema).
    const originalPrepare = Database.prototype.prepare
    let injectV2Failure = true
    Database.prototype.prepare = function (...prepareArguments: Parameters<typeof originalPrepare>) {
      const statement = originalPrepare.apply(this, prepareArguments)
      if (!injectV2Failure || typeof prepareArguments[0] !== "string" || !prepareArguments[0].includes("(time_created, rowid) <")) return statement
      return {
        all() { throw new Error("synthetic page failure") },
        finalize() { statement.finalize() },
      } as ReturnType<typeof originalPrepare>
    } as typeof originalPrepare
    try {
      const failureSource = createHistorySource({ dataDirOverride: fixtureDirectory, maxEntries: 2 })
      await failureSource.whenReady()
      assertScan(JSON.stringify(failureSource.entries().map((entry) => entry.text)) === JSON.stringify(["repeat", "legacy tail unique"]), "failed second V2 page discards partial V2 entries before legacy fallback")
      assertScan(failureSource.readStats().databaseLoads === 1, "legacy recovery still counts one successful DB load")
    } finally {
      injectV2Failure = false
      Database.prototype.prepare = originalPrepare
    }

    let scanFinished = false
    let timerRanBeforeCompletion = false
    const timer = setTimeout(() => { timerRanBeforeCompletion = !scanFinished }, 0)
    const scanStart = performance.now()
    const historySource = createHistorySource({ dataDirOverride: fixtureDirectory, maxEntries: 3 })
    await historySource.whenReady()
    scanFinished = true
    clearTimeout(timer)
    const scanElapsedMs = performance.now() - scanStart
    assertScan(timerRanBeforeCompletion, "timer must execute during DB pagination, before completion")
    assertScan(historySource.readStats().databaseLoads === 1, "long scan counts as exactly one DB load")
    assertScan(JSON.stringify(historySource.entries().map((entry) => entry.text)) === JSON.stringify(["repeat", "v2 tail unique", "legacy tail unique"]), "scan never truncates filtered or duplicate rows, including NULL timestamps and legacy multipart")
    const continuationDatabase = new Database(nodePath.join(fixtureDirectory, "opencode.db"), { readonly: true })
    const v2FirstPage = continuationDatabase.prepare("SELECT time_created AS sortTime, rowid AS messageRowId FROM session_message WHERE type = 'user' AND time_created IS NOT NULL ORDER BY time_created DESC, rowid DESC LIMIT ?").all(256)
    const v2Cursor = v2FirstPage[v2FirstPage.length - 1]
    const v2NextPage = continuationDatabase.prepare("SELECT time_created AS sortTime, rowid AS messageRowId FROM session_message WHERE type = 'user' AND (time_created, rowid) < (?, ?) ORDER BY time_created DESC, rowid DESC LIMIT ?").all(v2Cursor.sortTime, v2Cursor.messageRowId, 256)
    assertScan(v2NextPage.length === 256 && v2NextPage[0].messageRowId < v2Cursor.messageRowId, "V2 repeated timestamps advance by rowid without replaying the page boundary")
    const legacyFirstPage = continuationDatabase.prepare(`SELECT message.time_created AS sortTime, message.rowid AS messageRowId, part.rowid AS partRowId FROM message JOIN part ON part.message_id = message.id WHERE message.id = 'multipart-boundary' ORDER BY message.time_created DESC, message.rowid DESC, part.rowid DESC LIMIT ?`).all(256)
    const legacyCursor = legacyFirstPage[legacyFirstPage.length - 1]
    const legacyNextPage = continuationDatabase.prepare(`SELECT part.rowid AS partRowId FROM message JOIN part ON part.message_id = message.id WHERE message.id = 'multipart-boundary' AND (message.time_created, message.rowid, part.rowid) < (?, ?, ?) ORDER BY message.time_created DESC, message.rowid DESC, part.rowid DESC LIMIT ?`).all(legacyCursor.sortTime, legacyCursor.messageRowId, legacyCursor.partRowId, 256)
    assertScan(legacyNextPage.length === 44 && legacyNextPage[0].partRowId < legacyCursor.partRowId, "legacy multipart cursor advances across 256-part page boundary")
    continuationDatabase.close()
    console.log(`PASS synthetic SQLite scan: ${recentRowCount + legacyRowCount + 304} rows, ${baselinePages} sampled OFFSET pages ×256 rows ${baselineElapsedMs.toFixed(1)}ms (not a full-scan comparison), complete cooperative keyset scan with 256-row pages ${scanElapsedMs.toFixed(1)}ms, timer before completion`)
  } finally {
    if (previousDatabaseOverride === undefined) delete process.env["OPENCODE_DB"]
    else process.env["OPENCODE_DB"] = previousDatabaseOverride
    // Bun/Windows may hold the just-closed SQLite file briefly. The fixture
    // has no personal content; cleanup is best effort, not a test failure.
    for (let cleanupAttempt = 0; cleanupAttempt < 20; cleanupAttempt++) {
      try {
        nodeFs.rmSync(fixtureDirectory, { recursive: true, force: true })
        break
      } catch (cleanupError) {
        if (cleanupAttempt === 19) console.warn(`Synthetic fixture cleanup deferred (${String((cleanupError as Error).name)})`)
        else await Bun.sleep(100)
      }
    }
  }
}

if (process.argv.includes("--history-scan-child")) {
  await runNullTimeSeekFixture()
  await runLargeSqliteFixture()
} else {
  const runChild = async (): Promise<void> => {
    const testFilePath = fileURLToPath(import.meta.url)
    await new Promise<void>((resolve, reject) => {
      const child = spawn(process.execPath, [testFilePath, "--history-scan-child"], { stdio: ["ignore", "pipe", "pipe"] })
      let standardOutput = ""
      let standardError = ""
      child.stdout.setEncoding("utf8").on("data", (chunk: string) => { standardOutput += chunk })
      child.stderr.setEncoding("utf8").on("data", (chunk: string) => { standardError += chunk })
      child.once("error", reject)
      child.once("close", (exitCode) => {
        if (exitCode !== 0) reject(new Error(`Isolated synthetic DB scan failed (exit=${exitCode}):\n${standardOutput}\n${standardError}`))
        else { process.stdout.write(standardOutput); resolve() }
      })
    })
  }
  try {
    test("synthetic SQLite keyset scan completeness and timer responsiveness", runChild, 120_000)
  } catch (registrationError) {
    if (!(registrationError instanceof Error) || !registrationError.message.includes("Cannot use test outside of the test runner")) throw registrationError
    await runNullTimeSeekFixture()
    await runLargeSqliteFixture()
  }
}
