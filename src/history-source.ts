/**
 * opencode-history-ghost 历史数据源（DESIGN §3.1）。
 *
 * 数据来自两处（只读，绝不写入）：
 *  1. opencode SQLite DB 中的用户消息（session_message，V1 legacy 时代为 message JOIN part）；
 *  2. ~/.local/state/opencode/prompt-history.jsonl（每行一个 PromptInfo JSON，末尾行最新）。
 *
 * 降级链：bun:sqlite > node:sqlite > jsonl-only（warn 一次，绝不抛错崩宿主）。
 * refresh() 只做 jsonl mtime 变化检测，DB 只在初始化时加载一次。
 * DB 查询带 LIMIT maxEntries（新到旧），只物化最新条目，避免启动期全量扫描大库。
 */

import * as nodeFs from "node:fs"
import * as nodeOs from "node:os"
import * as nodePath from "node:path"

export interface HistoryEntry {
  /** 原文（多行保留原样） */
  text: string
  /** 预计算小写副本（每键匹配省掉一次 lowercase） */
  lower: string
}

export interface HistorySource {
  /** 最新在前；已去重、已过滤、已截断到上限 */
  entries(): HistoryEntry[]
  /** jsonl mtime 变化时重新合并；由外层定时调用，内部有变化检测 */
  refresh(): void
}

export interface HistorySourceOptions {
  /** 测试用：覆盖 opencode 数据目录（opencode*.db 与 prompt-history.jsonl 都从这里找） */
  dataDirOverride?: string
  /** 历史条目上限，默认 2000 */
  maxEntries?: number
  /** 单条历史文本长度上限，默认 2000 字符（防超长粘贴文本被建议） */
  maxTextLength?: number
}

/** 供冒烟脚本观测加载行为；不影响 HistorySource 契约 */
export interface HistorySourceReadStats {
  /** jsonl 文件被完整重读的次数 */
  jsonlReads: number
  /** DB 用户消息查询执行次数（设计为 0 或 1） */
  databaseLoads: number
}

/** HistorySource 之上的可选扩展；tui 侧只依赖 HistorySource 亦完全兼容 */
export type HistorySourceWithDebug = HistorySource & {
  /** 初始化（含 DB 后台加载）完成后 resolve；冒烟脚本用它拿到确定性结果 */
  whenReady(): Promise<void>
  readStats(): HistorySourceReadStats
}

export const DEFAULT_MAX_HISTORY_ENTRIES = 2000
export const DEFAULT_MAX_TEXT_LENGTH = 2000

const MIN_FILTERED_TEXT_LENGTH = 2
const DEFAULT_OPENCODE_DATA_DIR = nodePath.join(nodeOs.homedir(), ".local", "share", "opencode")
const DEFAULT_PROMPT_HISTORY_JSONL_PATH = nodePath.join(
  nodeOs.homedir(),
  ".local",
  "state",
  "opencode",
  "prompt-history.jsonl",
)

/** 统一的只读 SQLite 访问面：只暴露本模块用到的两个操作 */
interface SqliteStatementAdapter {
  /** 位置参数绑定执行（bun:sqlite 与 node:sqlite 均支持匿名位置参数） */
  all(...boundParameters: unknown[]): Array<Record<string, unknown>>
}

interface SqliteDatabaseAdapter {
  prepare(sql: string): SqliteStatementAdapter
  close(): void
}

export function createHistorySource(options: HistorySourceOptions = {}): HistorySourceWithDebug {
  return new SqliteAndJsonlHistorySource(options)
}

class SqliteAndJsonlHistorySource implements HistorySource {
  private readonly databaseDirectory: string
  private readonly promptHistoryJsonlPath: string
  private readonly maxEntries: number
  private readonly maxTextLength: number
  private readonly readyPromise: Promise<void>

  private jsonlTexts: string[] = []
  private databaseTexts: string[] = []
  private mergedEntries: HistoryEntry[] = []
  private lastJsonlMtimeMs: number | null = null
  private jsonlReadCount = 0
  private databaseLoadCount = 0
  private hasWarnedDegraded = false

  constructor(options: HistorySourceOptions) {
    this.maxEntries = toNonNegativeIntegerOr(options.maxEntries, DEFAULT_MAX_HISTORY_ENTRIES)
    this.maxTextLength = options.maxTextLength ?? DEFAULT_MAX_TEXT_LENGTH
    if (options.dataDirOverride !== undefined) {
      // 测试夹具目录：DB 候选与 jsonl 都从覆盖目录里找
      this.databaseDirectory = options.dataDirOverride
      this.promptHistoryJsonlPath = nodePath.join(options.dataDirOverride, "prompt-history.jsonl")
    } else {
      this.databaseDirectory = DEFAULT_OPENCODE_DATA_DIR
      this.promptHistoryJsonlPath = DEFAULT_PROMPT_HISTORY_JSONL_PATH
    }
    this.reloadJsonl()
    this.readyPromise = this.loadDatabaseInBackground()
  }

  entries(): HistoryEntry[] {
    return this.mergedEntries
  }

  refresh(): void {
    const currentMtimeMs = statMtimeMsOrNull(this.promptHistoryJsonlPath)
    if (currentMtimeMs === this.lastJsonlMtimeMs) return
    this.reloadJsonl()
  }

  whenReady(): Promise<void> {
    return this.readyPromise
  }

  readStats(): HistorySourceReadStats {
    return { jsonlReads: this.jsonlReadCount, databaseLoads: this.databaseLoadCount }
  }

  private async loadDatabaseInBackground(): Promise<void> {
    const databaseFilePath = resolveDatabaseFilePath(this.databaseDirectory)
    if (databaseFilePath === null) {
      this.warnDegradedOnce(`未找到 opencode DB（查找目录：${this.databaseDirectory}），降级 jsonl-only`)
      return
    }
    const openOutcome = await openSqliteReadonly(databaseFilePath)
    if (openOutcome.database === null) {
      this.warnDegradedOnce(
        `opencode DB 无法打开（bun:sqlite 与 node:sqlite 均不可用：${databaseFilePath}；` +
          `底层原因：${openOutcome.failureSummary}），降级 jsonl-only`,
      )
      return
    }
    const database = openOutcome.database
    try {
      this.databaseTexts = readUserTextsFromDatabase(database, this.maxEntries)
      this.databaseLoadCount += 1
      this.rebuildMergedEntries()
    } catch (queryError) {
      this.warnDegradedOnce(`opencode DB schema 不适配（${String(queryError)}），降级 jsonl-only`)
    } finally {
      try {
        database.close()
      } catch {
        // 关闭失败无需处理：连接早已不可用也不影响后续逻辑
      }
    }
  }

  private reloadJsonl(): void {
    this.jsonlReadCount += 1
    let jsonlTexts: string[] = []
    let jsonlMtimeMs: number | null = null
    try {
      const jsonlContent = nodeFs.readFileSync(this.promptHistoryJsonlPath, "utf8")
      jsonlMtimeMs = statMtimeMsOrNull(this.promptHistoryJsonlPath)
      jsonlTexts = parseJsonlTextsNewestFirst(jsonlContent)
    } catch {
      // 文件不存在或不可读：保持空列表（本会话可能从未提交过 prompt）
    }
    this.jsonlTexts = jsonlTexts
    this.lastJsonlMtimeMs = jsonlMtimeMs
    this.rebuildMergedEntries()
  }

  private rebuildMergedEntries(): void {
    const seenTexts = new Set<string>()
    const mergedEntries: HistoryEntry[] = []
    // jsonl（最新）在前，DB 在后；Map/Set 去重保留首个出现即最新
    for (const text of this.jsonlTexts) this.appendFilteredEntry(text, seenTexts, mergedEntries)
    for (const text of this.databaseTexts) this.appendFilteredEntry(text, seenTexts, mergedEntries)
    this.mergedEntries = mergedEntries.slice(0, this.maxEntries)
  }

  private appendFilteredEntry(
    text: string,
    seenTexts: Set<string>,
    mergedEntries: HistoryEntry[],
  ): void {
    // 存储与去重均用归一+trim 后文本：先统一 \r\n → \n（多行历史内部不再残留 \r，
    // ghost-line 的 split("\n") 不会切出带 \r 的行），再 trim 保证 accept 后
    // evaluate(trim(输入)) 与候选原文严格相等，"完全相同排除"不会因首尾空白失效
    // （避免接受后同一条建议立即重弹）
    const normalizedText = normalizeLineEndings(text)
    const trimmedText = normalizedText.trim()
    if (seenTexts.has(trimmedText)) return
    if (!passesHistoryTextFilter(trimmedText, this.maxTextLength)) return
    seenTexts.add(trimmedText)
    mergedEntries.push({ text: trimmedText, lower: trimmedText.toLowerCase() })
  }

  private warnDegradedOnce(message: string): void {
    if (this.hasWarnedDegraded) return
    this.hasWarnedDegraded = true
    console.warn(`[opencode-history-ghost] ${message}`)
  }
}

/** DB 路径解析：OPENCODE_DB 环境变量 > opencode.db > 同目录 mtime 最新的 opencode*.db */
function resolveDatabaseFilePath(databaseDirectory: string): string | null {
  const environmentDatabasePath = process.env["OPENCODE_DB"]
  if (environmentDatabasePath !== undefined && environmentDatabasePath.trim().length > 0) {
    return environmentDatabasePath
  }
  const primaryDatabasePath = nodePath.join(databaseDirectory, "opencode.db")
  if (fileExists(primaryDatabasePath)) return primaryDatabasePath
  return findNewestDatabaseInDirectory(databaseDirectory)
}

function findNewestDatabaseInDirectory(databaseDirectory: string): string | null {
  let directoryEntries: string[]
  try {
    directoryEntries = nodeFs.readdirSync(databaseDirectory)
  } catch {
    return null
  }
  let newestDatabasePath: string | null = null
  let newestMtimeMs = -1
  for (const fileName of directoryEntries) {
    if (!fileName.startsWith("opencode") || !fileName.endsWith(".db")) continue
    const candidatePath = nodePath.join(databaseDirectory, fileName)
    try {
      const candidateStats = nodeFs.statSync(candidatePath)
      if (candidateStats.isFile() && candidateStats.mtimeMs > newestMtimeMs) {
        newestMtimeMs = candidateStats.mtimeMs
        newestDatabasePath = candidatePath
      }
    } catch {
      // 单个文件 stat 失败：跳过该候选
    }
  }
  return newestDatabasePath
}

/** openSqliteReadonly 的结果：成功给 database；双后端均失败给 failureSummary（底层原因摘要） */
interface SqliteOpenOutcome {
  database: SqliteDatabaseAdapter | null
  failureSummary: string | undefined
}

/**
 * 只读打开：优先 bun:sqlite（TUI 宿主运行时），失败则 node:sqlite，再失败返回
 * database=null 且 failureSummary 汇总两个后端各自的底层错误（区分"运行时没有
 * 该后端"与"文件打不开"，warn 文案带上真实原因，不掩盖）。
 */
async function openSqliteReadonly(databaseFilePath: string): Promise<SqliteOpenOutcome> {
  const backendFailureReasons: string[] = []
  try {
    const bunSqliteModule = (await import("bun:sqlite")) as unknown as {
      Database: new (filePath: string, options: { readonly: boolean }) => SqliteDatabaseAdapter
    }
    return { database: new bunSqliteModule.Database(databaseFilePath, { readonly: true }), failureSummary: undefined }
  } catch (bunSqliteError) {
    backendFailureReasons.push(`bun:sqlite → ${describeUnderlyingError(bunSqliteError)}`)
  }
  try {
    const nodeSqliteModule = (await import("node:sqlite")) as unknown as {
      DatabaseSync: new (filePath: string, options: { readOnly: boolean }) => SqliteDatabaseAdapter
    }
    return {
      database: new nodeSqliteModule.DatabaseSync(databaseFilePath, { readOnly: true }),
      failureSummary: undefined,
    }
  } catch (nodeSqliteError) {
    backendFailureReasons.push(`node:sqlite → ${describeUnderlyingError(nodeSqliteError)}`)
    return { database: null, failureSummary: backendFailureReasons.join("；") }
  }
}

/** 底层错误摘要：取 message，超长截断，避免 warn 一行被超长堆栈/路径刷屏 */
function describeUnderlyingError(error: unknown): string {
  const rawMessage = error instanceof Error ? error.message : String(error)
  const truncatedLength = 160
  if (rawMessage.length <= truncatedLength) return rawMessage
  return `${rawMessage.slice(0, truncatedLength)}…`
}

/** schema 自适应：先试 V2 session_message，失败再试 V1 legacy message JOIN part，都失败抛错由调用方降级 */
function readUserTextsFromDatabase(database: SqliteDatabaseAdapter, rowLimit: number): string[] {
  try {
    return readUserTextsFromSessionMessageTable(database, rowLimit)
  } catch {
    // V2 表不存在或查询失败：尝试 V1 legacy
  }
  return readUserTextsFromLegacyMessagePartTables(database, rowLimit)
}

/** 只物化最新 rowLimit 条 user 行（LIMIT 参数绑定，新到旧语义不变），避免全量物化大库所有行 */
function readUserTextsFromSessionMessageTable(
  database: SqliteDatabaseAdapter,
  rowLimit: number,
): string[] {
  const rows = database
    .prepare(
      "SELECT data FROM session_message WHERE type = 'user' ORDER BY time_created DESC LIMIT ?",
    )
    .all(rowLimit)
  const userTexts: string[] = []
  for (const row of rows) {
    const extractedText = extractTextFromSessionMessageData(row["data"])
    if (extractedText !== null) userTexts.push(extractedText)
  }
  return userTexts
}

function extractTextFromSessionMessageData(rawColumnValue: unknown): string | null {
  let messageData: unknown = rawColumnValue
  if (typeof messageData === "string") {
    try {
      messageData = JSON.parse(messageData)
    } catch {
      return null
    }
  }
  if (messageData === null || typeof messageData !== "object") return null
  const messageRecord = messageData as Record<string, unknown>
  // data.parts 存在时：拼接其中 text parts（流式分片场景）
  if (Array.isArray(messageRecord["parts"])) {
    const joinedPartsText = messageRecord["parts"]
      .map((part) => (part !== null && typeof part === "object" && typeof (part as Record<string, unknown>)["text"] === "string"
        ? ((part as Record<string, unknown>)["text"] as string)
        : ""))
      .join("")
    if (joinedPartsText.trim().length > 0) return joinedPartsText
  }
  if (typeof messageRecord["text"] === "string" && messageRecord["text"].trim().length > 0) {
    return messageRecord["text"]
  }
  return null
}

function readUserTextsFromLegacyMessagePartTables(
  database: SqliteDatabaseAdapter,
  rowLimit: number,
): string[] {
  const rows = database
    .prepare(
      `SELECT part.data AS partData FROM message
       JOIN part ON part.message_id = message.id
       WHERE message.data LIKE '%"role":"user"%'
       ORDER BY message.time_created DESC
       LIMIT ?`,
    )
    .all(rowLimit)
  const userTexts: string[] = []
  for (const row of rows) {
    const partText = extractTextFromLegacyPartData(row["partData"])
    if (partText !== null) userTexts.push(partText)
  }
  return userTexts
}

function extractTextFromLegacyPartData(rawColumnValue: unknown): string | null {
  let partData: unknown = rawColumnValue
  if (typeof partData === "string") {
    try {
      partData = JSON.parse(partData)
    } catch {
      return null
    }
  }
  if (partData === null || typeof partData !== "object") return null
  const partRecord = partData as Record<string, unknown>
  if (partRecord["type"] !== "text") return null
  if (typeof partRecord["text"] === "string" && partRecord["text"].trim().length > 0) {
    return partRecord["text"]
  }
  return null
}

/** jsonl 每行一个 PromptInfo{text,...}；文件末尾行最新 → 反转遍历使最新在前 */
function parseJsonlTextsNewestFirst(jsonlContent: string): string[] {
  const jsonlLines = jsonlContent.split(/\r?\n/)
  const promptTexts: string[] = []
  for (let lineIndex = jsonlLines.length - 1; lineIndex >= 0; lineIndex -= 1) {
    const trimmedLine = jsonlLines[lineIndex].trim()
    if (trimmedLine.length === 0) continue
    try {
      const promptInfo = JSON.parse(trimmedLine) as Record<string, unknown>
      if (typeof promptInfo["text"] === "string") promptTexts.push(promptInfo["text"])
    } catch {
      // 跳过损坏行
    }
  }
  return promptTexts
}

/** 内部换行归一：\r\n 统一为 \n（存储链全用归一后文本，渲染端按 "\n" 切行不会切出 \r） */
function normalizeLineEndings(text: string): string {
  return text.replace(/\r\n/g, "\n")
}

/** LIMIT 只接受非负整数：非有限数/负数回退默认值，浮数向下取整（防注入不敏感，但仍保证参数形状合法） */
function toNonNegativeIntegerOr(rawLimit: number | undefined, fallbackLimit: number): number {
  if (rawLimit === undefined) return fallbackLimit
  if (!Number.isFinite(rawLimit) || rawLimit < 0) return fallbackLimit
  return Math.floor(rawLimit)
}

/** 过滤：trim 后 ≥2 字符、长度 ≤ maxTextLength、不以 / 开头（宿主 slash 命令） */
function passesHistoryTextFilter(text: string, maxTextLength: number): boolean {
  const trimmedText = text.trim()
  if (trimmedText.length < MIN_FILTERED_TEXT_LENGTH) return false
  if (trimmedText.length > maxTextLength) return false
  if (trimmedText.startsWith("/")) return false
  return true
}

function fileExists(filePath: string): boolean {
  try {
    return nodeFs.statSync(filePath).isFile()
  } catch {
    return false
  }
}

function statMtimeMsOrNull(filePath: string): number | null {
  try {
    return nodeFs.statSync(filePath).mtimeMs
  } catch {
    return null
  }
}
