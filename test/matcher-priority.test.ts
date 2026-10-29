/**
 * matcher 相关性分层与最短输入单元测试（无测试框架，风格同 ghost-core.test.ts）。
 *
 * 覆盖：
 *   - 相关性分层：前缀组 > 子串组 > fuzzy 组，fuzzy 仅在前两组不足 N 时补位且排最后
 *   - 组内保持历史数组顺序（最新在前），即同相关性时按输入时间由近到远
 *   - 候选上限 N=10（含默认值与显式值）
 *   - 与输入完全相同的候选被排除
 *   - 最短输入按文字单元计数：纯 CJK 2 字出建议、1 字不出；英文 2 字不出、3 字出；
 *     混排 "CJK+ASCII" 按 3 处理；emoji / 组合字符不算两个 CJK
 *   - settings.minChars 语义：仍是非 CJK 阈值，纯 CJK 放宽上限为 min(minChars, 2)
 *
 * 运行：bun test/matcher-priority.test.ts
 */

import type { HistoryEntry } from "../src/history-source"
import {
  collectMatchBuckets,
  countTextUnits,
  findCandidates,
  isAllCjkText,
  meetsInputLengthRequirement,
  requiredInputUnitCount,
} from "../src/matcher"
import { createSuggestionStore, type HistoryGhostSettings } from "../src/suggestion-store"

let failedAssertionCount = 0

function assertTruthy(label: string, condition: boolean): void {
  console.log(`  ${condition ? "PASS" : "FAIL"}  ${label}`)
  if (!condition) failedAssertionCount += 1
}

function assertEqual<T>(label: string, actualValue: T, expectedValue: T): void {
  const condition = actualValue === expectedValue
  const mismatchDetail = condition
    ? ""
    : `（actual=${JSON.stringify(actualValue)} expected=${JSON.stringify(expectedValue)}）`
  console.log(`  ${condition ? "PASS" : "FAIL"}  ${label}${mismatchDetail}`)
  if (!condition) failedAssertionCount += 1
}

function assertTexts(label: string, actualEntries: HistoryEntry[], expectedTexts: string[]): void {
  const actualTexts = actualEntries.map((entry) => entry.text)
  const condition = JSON.stringify(actualTexts) === JSON.stringify(expectedTexts)
  console.log(
    `  ${condition ? "PASS" : "FAIL"}  ${label}` +
 (condition ? "" : `（actual=${JSON.stringify(actualTexts)} expected=${JSON.stringify(expectedTexts)}）`),
  )
  if (!condition) failedAssertionCount += 1
}

/** 按"最新在前"给出历史：数组下标越小越新 */
function makeHistoryNewestFirst(textsNewestFirst: string[]): HistoryEntry[] {
  return textsNewestFirst.map((text) => ({ text, lower: text.toLowerCase() }))
}

/** 生成 N 条互不相同、都能被 "abc" 前缀命中的填充历史 */
function makePrefixFillers(count: number): string[] {
  return Array.from({ length: count }, (_, fillerIndex) => `abc-filler-${fillerIndex}`)
}

function runRelevanceLayeringScenario(): void {
  console.log("[1] 相关性分层：前缀 > 子串，组内保持新到旧")
  // 数组下标越小越新：前缀组 = [此条较旧, 最新]，子串组 = [子串较旧, 子串最新]
  const history = makeHistoryNewestFirst([
    "zzz contains abc inside", // 子串中最旧的
    "abc older prefix", // 前缀中最旧的
    "xabc nearer substring", // 子串中最新的
    "abc newest prefix", // 前缀中最新的
  ])
  assertTexts(
    "前缀组整体排在前，子串组随后；前缀组内仍是新到旧",
    findCandidates(history, "abc", {}),
    [
      "abc older prefix",
      "abc newest prefix",
      "zzz contains abc inside",
      "xabc nearer substring",
    ],
  )

  const prefixFirst = findCandidates(makeHistoryNewestFirst(["zzzabc", "abc-second"]), "abc", {})
  assertTexts("即使子串更新，前缀仍绝对优先", prefixFirst, ["abc-second", "zzzabc"])
}

function runGroupOrderPreservedScenario(): void {
  console.log("[2] 组内顺序：同相关性时保持历史数组的新到旧顺序（不引入矛盾排序）")
  const history = makeHistoryNewestFirst([
    "abc alpha newest",
    "abc beta middle",
    "abc gamma oldest",
  ])
  assertTexts(
    "前缀组内顺序与历史顺序一致（最新在前）",
    findCandidates(history, "abc", {}),
    ["abc alpha newest", "abc beta middle", "abc gamma oldest"],
  )

  const substringHistory = makeHistoryNewestFirst([
    "q abc newest",
    "q abc middle",
    "q abc oldest",
  ])
  assertTexts(
    "子串组内顺序与历史顺序一致（最新在前）",
    findCandidates(substringHistory, "abc", {}),
    ["q abc newest", "q abc middle", "q abc oldest"],
  )

  const reversedHistory = makeHistoryNewestFirst(["zzzabc oldest-typed", "aabcz newest-typed"])
  const bucketedCandidates = findCandidates(reversedHistory, "abc", {})
  assertTexts(
    "候选顺序严格来自输入数组顺序，不做分数/字典序重排",
    bucketedCandidates,
    ["zzzabc oldest-typed", "aabcz newest-typed"],
  )
}

function runCandidateLimitScenario(): void {
  console.log("[3] 候选上限 N：默认 10，显式值生效")
  const twelvePrefixEntries = makePrefixFillers(12)
  const limitedCandidates = findCandidates(makeHistoryNewestFirst(twelvePrefixEntries), "abc", {})
  assertEqual("默认上限为 10 条", limitedCandidates.length, 10)
  assertTexts(
    "默认上限截断到最新 10 条",
    limitedCandidates,
    twelvePrefixEntries.slice(0, 10),
  )
  assertEqual(
    "显式 maxCandidates=3 生效",
    findCandidates(makeHistoryNewestFirst(twelvePrefixEntries), "abc", { maxCandidates: 3 }).length,
    3,
  )
  assertEqual(
    "默认 maxCandidates 与 tui 默认设置一致（10）",
    findCandidates(makeHistoryNewestFirst(twelvePrefixEntries), "abc", { maxCandidates: 10 }).length,
    10,
  )
  assertEqual(
    "maxCandidates=0 返回空",
    findCandidates(makeHistoryNewestFirst(twelvePrefixEntries), "abc", { maxCandidates: 0 }).length,
    0,
  )
}

function runFuzzyBackfillScenario(): void {
  console.log("[4] fuzzy 补位：仅在前两组不足 N 时出现，且永远排最后")
  const fuzzyOnlyHistory = makeHistoryNewestFirst([
    "a-b-c scattered newest",
    "aXbYc scattered older",
    "nothing in common here",
  ])
  const fuzzyOnlyCandidates = findCandidates(fuzzyOnlyHistory, "abc", {})
  assertTruthy("不足 N 时 fuzzy 补位出候选", fuzzyOnlyCandidates.length > 0)
  const fuzzyCandidateTexts = fuzzyOnlyCandidates.map((entry) => entry.text)
  assertTruthy(
    "纯 fuzzy 候选按分数降序：更贴合输入的那条排在前面",
    fuzzyCandidateTexts.indexOf("a-b-c scattered newest") >= 0 &&
      (fuzzyCandidateTexts.indexOf("aXbYc scattered older") === -1 ||
        fuzzyCandidateTexts.indexOf("a-b-c scattered newest") <
          fuzzyCandidateTexts.indexOf("aXbYc scattered older")),
  )

  const mixedHistory = makeHistoryNewestFirst([
    "a-b-c scattered newest", // fuzzy，最新
    "zzz abc substring", // 子串
    "abc prefix oldest", // 前缀
  ])
  assertTexts(
    "前缀 > 子串 > fuzzy：fuzzy 即便更新也排最后",
    findCandidates(mixedHistory, "abc", {}),
    ["abc prefix oldest", "zzz abc substring", "a-b-c scattered newest"],
  )

  const fullPrefixHistory = [...makePrefixFillers(10), "a-b-c scattered fuzzy"]
  const fullPrefixCandidates = findCandidates(makeHistoryNewestFirst(fullPrefixHistory), "abc", {})
  assertEqual("前两组已满 N 时不多取候选", fullPrefixCandidates.length, 10)
  assertTruthy(
    "前两组已满 N 时 fuzzy 不进入候选",
    fullPrefixCandidates.every((entry) => !entry.text.includes("a-b-c")),
  )

  const bucketsWhenFull = collectMatchBuckets(makeHistoryNewestFirst(fullPrefixHistory), "abc", 10)
  assertEqual("桶统计：满额时 fuzzy 桶为空", bucketsWhenFull.fuzzy.length, 0)
  const bucketsWhenSparse = collectMatchBuckets(
    makeHistoryNewestFirst(["abc prefix", "a-b-c scattered"]),
    "abc",
    10,
  )
  assertEqual("桶统计：不足时 fuzzy 桶有补位条目", bucketsWhenSparse.fuzzy.length, 1)

  const budgetHistory = makeHistoryNewestFirst([
    ...makePrefixFillers(9), // 9 条前缀，占 9 个名额
    "zzz abc substring", // 子串争第 10 个名额
    "a-b-c scattered fuzzy", // fuzzy 已无名额
  ])
  const budgetCandidates = findCandidates(budgetHistory, "abc", { maxCandidates: 10 })
  assertEqual("9 前缀 + 1 子串填满 10 个名额", budgetCandidates.length, 10)
  assertEqual("名额耗尽时 fuzzy 不补位", budgetCandidates[9].text, "zzz abc substring")
}

function runExactMatchExclusionScenario(): void {
  console.log("[5] 完全相同排除 / excludePrefixes / 去重 既有行为不变")
  const history = makeHistoryNewestFirst(["abc", "abc more", "abc more"])
  assertTexts(
    "与输入完全相同的候选被排除，重复文本去重",
    findCandidates(history, "abc", {}),
    ["abc more"],
  )
  assertEqual(
    "excludePrefixes 命中返回空",
    findCandidates(makeHistoryNewestFirst(["abc def"]), "/abc", {}).length,
    0,
  )
  assertEqual(
    "自定义 excludePrefixes 生效",
    findCandidates(makeHistoryNewestFirst(["!abc"]), "!abc", { excludePrefixes: ["!"] }).length,
    0,
  )
}

function runMinimumInputScenario(): void {
  console.log("[6] 最短输入：按文字单元计数，纯 CJK 2 字即可")
  const chineseHistory = makeHistoryNewestFirst(["你好世界", "你好世界 again"])

  assertEqual("countTextUnits(你好)=2", countTextUnits("你好"), 2)
  assertEqual(
    "countTextUnits(👩‍💻)=1（字素簇：ZWJ 序列算 1 个单元）",
    countTextUnits("👩‍💻"),
    1,
  )
  assertEqual("countTextUnits(e\\u0301)=1（组合音标并不额外计单元）", countTextUnits("e\u0301"), 1)
  assertTruthy("isAllCjkText(你好) 为真", isAllCjkText("你好"))
  assertTruthy("isAllCjkText(你好abc) 为假", !isAllCjkText("你好abc"))
  assertTruthy("isAllCjkText(你好👩‍💻) 为假（emoji 不是 CJK）", !isAllCjkText("你好👩‍💻"))
  assertTruthy("isAllCjkText(e\\u0301) 为假（组合音标不是 CJK）", !isAllCjkText("e\u0301"))

  assertEqual("中文两字满足阈值", meetsInputLengthRequirement("你好", 3), true)
  assertEqual("中文一字不满足阈值", meetsInputLengthRequirement("你", 3), false)
  assertEqual("英文两字不满足阈值", meetsInputLengthRequirement("ab", 3), false)
  assertEqual("英文三字满足阈值", meetsInputLengthRequirement("abc", 3), true)
  assertEqual(
    "混排 你好a：3 个单元达到非 CJK 阈值 3（但仍按 3 而非 2 处理）",
    meetsInputLengthRequirement("你好a", 3),
    true,
  )
  assertEqual(
    "混排 你好a 在 minChars=4 配置下不满足（说明用的是 3 而非 CJK 的 2）",
    meetsInputLengthRequirement("你好a", 4),
    false,
  )
  assertEqual(
    "混排 你a（2 单元，含非 CJK）按 3 处理：不满足",
    meetsInputLengthRequirement("你a", 3),
    false,
  )
  assertEqual("混排 abc你 满足（3 个单元）", meetsInputLengthRequirement("abc你", 3), true)
  assertEqual(
    "emoji 两枚 = 2 单元，不到 3，且不是 CJK：不满足",
    meetsInputLengthRequirement("👩‍💻👨‍💻", 3),
    false,
  )
  assertEqual(
    "组合字符两枚 = 2 单元，不到 3，且不是 CJK：不满足",
    meetsInputLengthRequirement("e\u0301a\u0301", 3),
    false,
  )
  assertEqual("空输入不满足", meetsInputLengthRequirement("", 3), false)

  assertTexts("中文两字出建议", findCandidates(chineseHistory, "你好", {}), [
    "你好世界",
    "你好世界 again",
  ])
  assertEqual("中文一字不出建议", findCandidates(chineseHistory, "你", {}).length, 0)
  assertTexts("英文两字被阈值挡住", findCandidates(makeHistoryNewestFirst(["abcdef"]), "ab", {}), [])
  assertTexts("英文三字出建议", findCandidates(makeHistoryNewestFirst(["abcdef"]), "abc", {}), [
    "abcdef",
  ])
  assertEqual(
    "CJK+ASCII 混排按 3 处理：两单元不出建议",
    findCandidates(makeHistoryNewestFirst(["你好abc"]), "你a", {}).length,
    0,
  )
  assertEqual(
    "emoji 输入不出建议（不是两个 CJK 单元）",
    findCandidates(makeHistoryNewestFirst(["👩‍💻👨‍💻code"]), "👩‍💻👨‍💻", {}).length,
    0,
  )
  assertEqual(
    "组合字符输入不出建议",
    findCandidates(makeHistoryNewestFirst(["e\u0301a\u0301clair"]), "e\u0301a\u0301", {}).length,
    0,
  )
}

function runMinCharsSettingCompatibilityScenario(): void {
  console.log("[7] settings.minChars 兼容：仍是非 CJK 阈值，CJK 放宽上限为 min(minChars, 2)")
  assertEqual("默认 3：非 CJK 阈值 3", requiredInputUnitCount("abc", 3), 3)
  assertEqual("默认 3：纯 CJK 阈值 2", requiredInputUnitCount("你好", 3), 2)
  assertEqual("用户配 5：非 CJK 阈值 5（配置不被覆盖）", requiredInputUnitCount("abc", 5), 5)
  assertEqual("用户配 5：纯 CJK 阈值仍 2", requiredInputUnitCount("你好", 5), 2)
  assertEqual("用户配 1：纯 CJK 阈值不低于 1", requiredInputUnitCount("你好", 1), 1)
  assertEqual("用户配 1：非 CJK 阈值 1", requiredInputUnitCount("a", 1), 1)

  const history = makeHistoryNewestFirst(["abcdef", "abcde"])
  assertEqual(
    "store 侧 settings.minChars=5 生效：四字英文不出建议",
    makeIsolatedStore(history, 5).evaluateAndReadTopText("abcd"),
    null,
  )
  assertEqual(
    "store 侧 settings.minChars=5 生效：五字英文出建议（新到旧首项）",
    makeIsolatedStore(history, 5).evaluateAndReadTopText("abcde"),
    "abcdef",
  )
  assertEqual(
    "store 侧纯 CJK 两字出建议（minChars=3 默认）",
    makeIsolatedStore(makeHistoryNewestFirst(["你好世界"]), 3).evaluateAndReadTopText("你好"),
    "你好世界",
  )
  assertEqual(
    "store 侧纯 CJK 一字不出建议",
    makeIsolatedStore(makeHistoryNewestFirst(["你好世界"]), 3).evaluateAndReadTopText("你"),
    null,
  )
}

/** 只测 store 的防御过滤与候选首项，历史数组固定 */
function makeIsolatedStore(historyEntries: HistoryEntry[], minChars: number): {
  evaluateAndReadTopText(rawInput: string): string | null
} {
  const settings: HistoryGhostSettings = {
    enabled: true,
    acceptKey: "tab",
    minChars,
    maxCandidates: 10,
    maxEntries: 2000,
    maxTextLength: 2000,
    excludePrefixes: ["/", "@"],
  }
  const store = createSuggestionStore(() => historyEntries, settings)
  return {
    evaluateAndReadTopText(rawInput: string): string | null {
      store.evaluate(rawInput)
      return store.current()?.text ?? null
    },
  }
}

function runFastPathStillWorksScenario(): void {
  console.log("[8] 增量快路径仍成立：延长输入时引用不变、索引不变")
  const store = createSuggestionStore(
    () => makeHistoryNewestFirst(["你好世界"]),
    {
      enabled: true,
      acceptKey: "tab",
      minChars: 3,
      maxCandidates: 10,
      maxEntries: 2000,
      maxTextLength: 2000,
      excludePrefixes: ["/", "@"],
    },
  )
  store.evaluate("你好")
  const stateAfterTwoChars = store.state()
  assertTruthy("两字 CJK 即出建议", stateAfterTwoChars !== null)
  if (!stateAfterTwoChars) return
  store.evaluate("你好世")
  const stateAfterExtension = store.state()
  assertEqual("快路径保持 candidates 引用不变", stateAfterExtension?.candidates, stateAfterTwoChars.candidates)
  assertEqual("快路径仅 input 前移", stateAfterExtension?.input, "你好世")
  assertEqual("快路径索引保持 0", stateAfterExtension?.index, 0)
}

function main(): void {
  runRelevanceLayeringScenario()
  runGroupOrderPreservedScenario()
  runCandidateLimitScenario()
  runFuzzyBackfillScenario()
  runExactMatchExclusionScenario()
  runMinimumInputScenario()
  runMinCharsSettingCompatibilityScenario()
  runFastPathStillWorksScenario()
  console.log("----")
  if (failedAssertionCount === 0) {
    console.log("测试结论：全部 PASS")
  } else {
    console.log(`测试结论：存在 FAIL（${failedAssertionCount} 处断言失败，见上）`)
    process.exitCode = 1
  }
}

main()