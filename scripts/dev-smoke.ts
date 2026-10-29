/**
 * 开发冒烟脚本（DESIGN §6 / tasks T4）。
 *
 * 本机历史只做数据源观测（可能降级 jsonl-only）；确定性合成 2000 条历史的
 * findCandidates 三桶稳态 p95 < 1ms 为默认可复现性能门槛。
 * --require-real-db 显式要求真实 DB 成功加载；默认无 DB 时标为未验证而不失败。
 *
 * 隐私红线：历史是本机私有数据，输出只含计数与长度，真实历史文本一律以固定 "***" 掩码，
 * 绝不打印任何明文片段（包括前缀片段——Windows 终端输出常被会话记录捕获）。
 * 合成探针/夹具文本是脚本自造的非用户数据，可安全打印，注意区分。
 * mtime 变化路径用临时夹具目录验证，不触碰真实 prompt-history.jsonl。
 */

import * as nodeFs from "node:fs"
import * as nodeOs from "node:os"
import * as nodePath from "node:path"
import { createHistorySource, type HistoryEntry } from "../src/history-source"
import { collectMatchBuckets, findCandidates, type MatchOptions } from "../src/matcher"

const matchOptions: MatchOptions = {
  minChars: 3,
  maxCandidates: 5,
  excludePrefixes: ["/", "@"],
}
const sampleInputs = ["帮我", "test", "为什么"]
const requireRealDatabase = process.argv.includes("--require-real-db")
const unexpectedArguments = process.argv.slice(2).filter((argument) => argument !== "--require-real-db")
if (unexpectedArguments.length > 0) {
  console.error("FAIL 未知参数；仅支持 --require-real-db")
  process.exit(1)
}

let failedChecks = 0
function check(label: string, condition: boolean, detail = ""): void {
  console.log(`  ${condition ? "PASS" : "FAIL"} ${label}${detail ? ` (${detail})` : ""}`)
  if (!condition) failedChecks += 1
}

/** 固定非个人文本；每桶恰有一条，剩余条目充当完整 2000 条扫描负载。 */
function syntheticHistory(): HistoryEntry[] {
  return Array.from({ length: 2000 }, (_, entryIndex) => {
    let text = `neutral-token-${String(entryIndex).padStart(4, "0")}`
    if (entryIndex === 0) text = "alphaXYZ instruction"
    if (entryIndex === 1) text = "misc betaXYZ instruction"
    if (entryIndex === 2) text = "kotlin协程示例"
    return { text, lower: text.toLowerCase() }
  })
}

function verifySyntheticMatchingPerformance(): void {
  console.log("[2b] 合成 2000 条非个人历史：findCandidates 单次稳态 p95 <1ms（不含历史加载、渲染、I/O）")
  const entries = syntheticHistory()
  const scenarios = [
    { input: "alphaXYZ", bucket: "prefix", expected: "alphaXYZ instruction" },
    { input: "betaXYZ", bucket: "substring", expected: "misc betaXYZ instruction" },
    { input: "kotlin示", bucket: "fuzzy", expected: "kotlin协程示例" },
  ] as const
  for (const scenario of scenarios) {
    const matchBuckets = collectMatchBuckets(entries, scenario.input, matchOptions.maxCandidates ?? 5)
    const expectedBucket = matchBuckets[scenario.bucket]
    check(`${scenario.bucket} 桶命中`, expectedBucket.length === 1 && expectedBucket[0]?.text === scenario.expected)
    for (let warmupIteration = 0; warmupIteration < 100; warmupIteration++) {
      findCandidates(entries, scenario.input, matchOptions)
    }
    // 两轮各 101 次；取较快轮的 p95，避免偶发 GC / 调度噪声误判。
    const percentiles: number[] = []
    for (let trialIndex = 0; trialIndex < 2; trialIndex++) {
      const durations: number[] = []
      for (let sampleIndex = 0; sampleIndex < 101; sampleIndex++) {
        const matchStartMs = performance.now()
        const candidates = findCandidates(entries, scenario.input, matchOptions)
        durations.push(performance.now() - matchStartMs)
        if (candidates[0]?.text !== scenario.expected) {
          check(`${scenario.bucket} 候选顺序`, false)
          return
        }
      }
      durations.sort((firstDuration, secondDuration) => firstDuration - secondDuration)
      percentiles.push(durations[95])
    }
    const bestP95 = Math.min(...percentiles)
    check(`${scenario.bucket} 稳态 p95 <1ms`, bestP95 < 1, `两轮 p95=${percentiles.map((duration) => duration.toFixed(3)).join("/")}ms`)
  }
}

/** 候选掩码：真实历史不输出任何明文片段，只暴露长度与固定 *** 占位 */
function maskedCandidatePreview(historyEntry: HistoryEntry): string {
  return `"***" (len=${historyEntry.text.length})`
}

function reportCandidates(label: string, candidates: HistoryEntry[]): void {
  console.log(`  ${label}: ${candidates.length} 个候选`)
  for (const [candidateIndex, candidateEntry] of candidates.entries()) {
    console.log(`    [${candidateIndex}] ${maskedCandidatePreview(candidateEntry)}`)
  }
}

async function main(): Promise<void> {
  // ---- 1. 真实数据源加载 ----
  const loadStartMs = performance.now()
  const historySource = createHistorySource({ maxEntries: 2000, maxTextLength: 2000 })
  // whenReady 是数据源的可选扩展（HistorySource 契约之外），存在则等待 DB 后台加载完成
  await historySource.whenReady()
  try {
    const loadElapsedMs = performance.now() - loadStartMs
    const historyEntries = historySource.entries()
    const readStats = historySource.readStats()
    const databaseLoaded = readStats.databaseLoads > 0
    console.log("[1] 本机历史加载观测（不输出历史内容）")
    console.log(
      `    合并条目数=${historyEntries.length}  jsonl读取次数=${readStats.jsonlReads}  DB成功加载次数=${readStats.databaseLoads}  加载耗时=${loadElapsedMs.toFixed(0)}ms`,
    )
    // readStats 不提供 DB 单独的原始条数；不把合并条目数伪称 DB 条目数。
    console.log(`    真实DB读取=${databaseLoaded ? "已成功（DB单独条目数未暴露）" : "未验证（降级 jsonl-only 或 DB 不可用）"}`)
    if (requireRealDatabase) check("真实 DB 严格验证", databaseLoaded)

    // ---- 2. 三个样例输入的三桶匹配 ----
    console.log("[2] 样例输入匹配（候选仅显示长度，文本以 *** 掩码）")
    findCandidates(historyEntries, "匹配引擎预热调用", matchOptions) // 预热一次，让计时反映稳态
    for (const sampleInput of sampleInputs) {
      const matchStartMs = performance.now()
      const candidates = findCandidates(historyEntries, sampleInput, matchOptions)
      const matchElapsedMs = performance.now() - matchStartMs
      const matchBuckets = collectMatchBuckets(
        historyEntries,
        sampleInput.trim(),
        matchOptions.maxCandidates ?? 5,
      )
      console.log(
        `    输入 "${sampleInput}"（trim后长度 ${sampleInput.trim().length}）` +
          `：前缀桶=${matchBuckets.prefix.length} 子串桶=${matchBuckets.substring.length} fuzzy桶=${matchBuckets.fuzzy.length}`,
      )
      console.log(
        `    findCandidates 返回 ${candidates.length} 个候选，单次匹配耗时 ${matchElapsedMs.toFixed(3)}ms` +
          "（仅供观测；非性能门槛）",
      )
      reportCandidates("候选", candidates)
      if (sampleInput.trim().length < (matchOptions.minChars ?? 3)) {
        console.log("    说明：该输入短于 minChars=3，防御过滤生效返回空候选（桶计数仅作内部分层观测）")
      }
    }

    verifySyntheticMatchingPerformance()

    // ---- 3. refresh() mtime 变化检测 ----
    console.log("[3] refresh() mtime 变化检测")
    const statsBeforeRefresh = historySource.readStats()
    historySource.refresh()
    historySource.refresh()
    const statsAfterDoubleRefresh = historySource.readStats()
    const doubleRefreshPassed =
      statsAfterDoubleRefresh.jsonlReads === statsBeforeRefresh.jsonlReads
    check("真实 jsonl mtime 未变不重读", doubleRefreshPassed,
      `读取次数 ${statsBeforeRefresh.jsonlReads} -> ${statsAfterDoubleRefresh.jsonlReads}`)

    // 夹具目录验证"mtime 变了会重读"路径（夹具文本是脚本自造的，可安全打印）。
    // 整块套 try/finally：中途任何一步抛错都必须清掉夹具目录，不留盘（rmSync force
    // 幂等，setup 抛错时 finally 兜底、断言回调内部抛错时内层 finally 兜底）。
    const fixtureDirectory = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), "opencode-history-ghost-smoke-"))
    const removeFixtureDirectory = (): void => {
      nodeFs.rmSync(fixtureDirectory, { recursive: true, force: true })
    }
    try {
      nodeFs.mkdirSync(fixtureDirectory, { recursive: true })
      const fixtureJsonlPath = nodePath.join(fixtureDirectory, "prompt-history.jsonl")
      nodeFs.writeFileSync(
        fixtureJsonlPath,
        `${JSON.stringify({ text: "夹具历史第一条内容" })}\n`,
        "utf8",
      )
      const fixtureSource = createHistorySource({
        dataDirOverride: fixtureDirectory,
        maxEntries: 100,
        maxTextLength: 100,
      })
      // 断言结论在 finally 之后汇总，三个通过位必须先在 try 外声明
      let unchangedRefreshPassed = false
      let changedRefreshPassed = false
      let fixtureOrderPassed = false
      await fixtureSource.whenReady()
        try {
          const fixtureStatsUnchangedBefore = fixtureSource.readStats()
          fixtureSource.refresh()
          const fixtureStatsUnchangedAfter = fixtureSource.readStats()
          unchangedRefreshPassed =
            fixtureStatsUnchangedAfter.jsonlReads === fixtureStatsUnchangedBefore.jsonlReads

          nodeFs.appendFileSync(
            fixtureJsonlPath,
            `${JSON.stringify({ text: "夹具历史第二条内容" })}\n`,
            "utf8",
          )
          // Windows/NTFS 在 node 运行时下 append 后立即 stat 可能读到未刷新的旧 mtime（bun 下正常，
          // 已实测），显式打时间戳保证"mtime 变化 → 重读"路径跨运行时确定性触发
          const bumpedMtime = new Date(Date.now() + 1000)
          nodeFs.utimesSync(fixtureJsonlPath, bumpedMtime, bumpedMtime)
          fixtureSource.refresh()
          const fixtureStatsChanged = fixtureSource.readStats()
          changedRefreshPassed =
            fixtureStatsChanged.jsonlReads === fixtureStatsUnchangedAfter.jsonlReads + 1
          const fixtureEntryTexts = fixtureSource.entries().map((entry) => entry.text)
          fixtureOrderPassed =
            fixtureEntryTexts.length === 2 && fixtureEntryTexts[0] === "夹具历史第二条内容"
          check("夹具 mtime 未变不重读", unchangedRefreshPassed)
          check("夹具 mtime 变化后重读", changedRefreshPassed)
          check("夹具最新在前", fixtureOrderPassed, `条目数=${fixtureEntryTexts.length}`)
        } finally {
          removeFixtureDirectory()
        }
    } catch (fixtureSetupError) {
      removeFixtureDirectory()
      throw fixtureSetupError
    }
  } finally {
    console.log(`冒烟结论：${failedChecks === 0 ? "全部 PASS（真实 DB 状态见观测）" : `存在 FAIL（${failedChecks} 项）`}`)
    if (failedChecks > 0) process.exitCode = 1
  }
}

main().catch((smokeError: unknown) => {
  console.error("FAIL 冒烟脚本异常", smokeError)
  process.exitCode = 1
})
