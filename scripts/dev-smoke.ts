/**
 * 开发冒烟脚本（DESIGN §6 / tasks T4）。
 *
 * 对本地真实 opencode DB 跑历史加载与三桶匹配，验证：
 *  1. 总条目数与数据源加载耗时；
 *  2. 三个样例输入的前缀/子串/fuzzy 三桶命中数与单次匹配耗时（< 1ms）；
 *  3. refresh() 在 jsonl mtime 未变时连续调用不重读；变了之后会重读。
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

function main(): void {
  // ---- 1. 真实数据源加载 ----
  const loadStartMs = performance.now()
  const historySource = createHistorySource({ maxEntries: 2000, maxTextLength: 2000 })
  // whenReady 是数据源的可选扩展（HistorySource 契约之外），存在则等待 DB 后台加载完成
  void historySource.whenReady().then(() => {
    const loadElapsedMs = performance.now() - loadStartMs
    const historyEntries = historySource.entries()
    const readStats = historySource.readStats()
    console.log("[1] 真实数据源加载完成")
    console.log(
      `    总条目数=${historyEntries.length}  jsonl读取=${readStats.jsonlReads}  DB加载=${readStats.databaseLoads}  加载耗时=${loadElapsedMs.toFixed(0)}ms`,
    )

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
          `${matchElapsedMs < 1 ? "（<1ms 达标）" : "（⚠ 超过 1ms）"}`,
      )
      reportCandidates("候选", candidates)
      if (sampleInput.trim().length < (matchOptions.minChars ?? 3)) {
        console.log("    说明：该输入短于 minChars=3，防御过滤生效返回空候选（桶计数仅作内部分层观测）")
      }
    }

    // ---- 2b. fuzzy 桶集成探针（合成文本，非用户历史，可安全打印） ----
    // 三个真实样例的前缀+子串桶均已填满候选（合并结果等价，fuzzy 被跳过），
    // 这里用合成历史强制走 fuzzy 路径，验证 fuzzysort v4 key 用法在运行时真实可用。
    // 输入 "kotlin示" 是 "kotlin协程示例" 的缺字变体：非前缀、非子串、fuzzy 分数实测 0.740 > 默认阈值 0.5。
    console.log("[2b] fuzzy 桶集成探针（合成历史，缺字输入 kotlin示 → 应 fuzzy 命中 kotlin协程示例）")
    const syntheticHistoryTexts = ["kotlin协程示例", "rust所有权练习", "golang goroutine调度"]
    const syntheticHistoryEntries: HistoryEntry[] = syntheticHistoryTexts.map((syntheticText) => ({
      text: syntheticText,
      lower: syntheticText.toLowerCase(),
    }))
    const syntheticCandidates = findCandidates(syntheticHistoryEntries, "kotlin示", matchOptions)
    const syntheticBuckets = collectMatchBuckets(
      syntheticHistoryEntries,
      "kotlin示",
      matchOptions.maxCandidates ?? 5,
    )
    const fuzzyProbePassed =
      syntheticBuckets.prefix.length === 0 &&
      syntheticBuckets.substring.length === 0 &&
      syntheticBuckets.fuzzy.length === 1 &&
      syntheticCandidates.length === 1 &&
      syntheticCandidates[0].text === "kotlin协程示例"
    console.log(
      `    前缀桶=${syntheticBuckets.prefix.length} 子串桶=${syntheticBuckets.substring.length} fuzzy桶=${syntheticBuckets.fuzzy.length}` +
        `  findCandidates 返回=${JSON.stringify(syntheticCandidates.map((entry) => entry.text))}` +
        `  ${fuzzyProbePassed ? "PASS" : "FAIL"}`,
    )

    // ---- 3. refresh() mtime 变化检测 ----
    console.log("[3] refresh() mtime 变化检测")
    const statsBeforeRefresh = historySource.readStats()
    historySource.refresh()
    historySource.refresh()
    const statsAfterDoubleRefresh = historySource.readStats()
    const doubleRefreshPassed =
      statsAfterDoubleRefresh.jsonlReads === statsBeforeRefresh.jsonlReads
    console.log(
      `    真实 jsonl：连刷 2 次 mtime 未变 → jsonl读取 ${statsBeforeRefresh.jsonlReads} -> ${statsAfterDoubleRefresh.jsonlReads}` +
        `${doubleRefreshPassed ? "（未重读，PASS）" : "（意外重读，FAIL）"}`,
    )

    // 夹具目录验证"mtime 变了会重读"路径（夹具文本是脚本自造的，可安全打印）。
    // 整块套 try/finally：中途任何一步抛错都必须清掉夹具目录，不留盘（rmSync force
    // 幂等，setup 抛错时 finally 兜底、断言回调内部抛错时内层 finally 兜底）。
    const fixtureDirectory = nodePath.join(nodeOs.tmpdir(), "opencode-history-ghost-smoke")
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
      void fixtureSource.whenReady().then(() => {
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
          console.log(
            `    夹具目录：mtime 未变 refresh 不重读=${unchangedRefreshPassed ? "PASS" : "FAIL"}  ` +
              `mtime 变化后重读=${changedRefreshPassed ? "PASS" : "FAIL"}  ` +
              `最新在前顺序=${fixtureOrderPassed ? "PASS" : "FAIL"}（entries=${JSON.stringify(fixtureEntryTexts)}）`,
          )
        } finally {
          removeFixtureDirectory()
        }

        const allPassed =
          doubleRefreshPassed &&
          unchangedRefreshPassed &&
          changedRefreshPassed &&
          fixtureOrderPassed &&
          fuzzyProbePassed
        console.log(`冒烟结论：${allPassed ? "全部 PASS" : "存在 FAIL，见上"}`)
      })
    } catch (fixtureSetupError) {
      removeFixtureDirectory()
      throw fixtureSetupError
    }
  })
}

main()
