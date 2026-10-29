/**
 * opencode-history-ghost 匹配引擎（DESIGN §3.2）。
 *
 * 纯函数、无状态：相关性分三层——前缀桶 > 子串桶 > fuzzy 桶；档内保持历史数组
 * 原有顺序（历史源保证"最新在前"），即同相关性时按输入时间由近到远。
 * 合并去重后截断到 maxCandidates。增量快路径不在这里（由 suggestion-store 处理）。
 *
 * 最短输入按"文字单元"计数（见 typedUnitLength）：纯 CJK 输入 2 个单元即可出建议，
 * 其余（含混排）仍用 3，避免给英文/emoji 输入过早弹建议。
 *
 * fuzzysort 用法按 v4.0.2 实测 API：
 *   fuzzysort.go(inputLower, 对象数组, { key: "lower", limit })
 *   → KeyResults（含 .obj 原对象 / .score，已按分数降序）。
 */

import type { HistoryEntry } from "./history-source"
import fuzzysort from "fuzzysort"

export interface MatchOptions {
  /**
   * 默认（非 CJK）最小输入单元数，默认 3（兼作防抖）。
   * 纯 CJK 输入自动放宽到 min(minChars, {CJK 最短输入单元数})，默认即 2；
   * 配成 1 时等价于 1，不会比用户配置更宽。
   */
  minChars?: number
  /** 候选上限 N，默认 10 */
  maxCandidates?: number
  /** 命中任一前缀则不出建议，默认 ["/", "@"]（宿主命令/引用补全域） */
  excludePrefixes?: string[]
}

/** 三桶分层结果；供 findCandidates 与冒烟脚本统计共用，避免逻辑重复 */
export interface MatchBuckets {
  prefix: HistoryEntry[]
  substring: HistoryEntry[]
  fuzzy: HistoryEntry[]
}

const DEFAULT_MIN_INPUT_CHARS = 3
const DEFAULT_MAX_CANDIDATES = 10
const DEFAULT_EXCLUDE_PREFIXES: readonly string[] = ["/", "@"]

/** 纯 CJK 输入的最短单元数：中文两个字即可出候选 */
export const MIN_CJK_INPUT_UNITS = 2

/** 单个文字单元：代理对（emoji 等）整体算一个，其余 code point 各算一个 */
const SINGLE_TEXT_UNIT_PATTERN = /[\uD800-\uDBFF][\uDC00-\uDFFF]|[\s\S]/gu

/** 字素簇分段器（按"用户感知的一个字"计数，emoji ZWJ 序列/组合音标各算 1）；运行时不支持时退回 code point */
const graphemeSegmenter: { segment(input: string): Iterable<unknown> } | null =
  typeof Intl !== "undefined" && typeof Intl.Segmenter === "function"
    ? new Intl.Segmenter(undefined, { granularity: "grapheme" })
    : null

/** 全部由 CJK 文字组成的输入（含汉字标点/注音等 CJK 区间） */
const ALL_CJK_INPUT_PATTERN = /^[\u3000-\u303F\u3040-\u30FF\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF\uFF00-\uFFEF\u{20000}-\u{3FFFF}]+$/u

/**
 * 按"文字单元"计数，而不是 UTF-16 length：UTF-16 length 会把 emoji 算成 2。
 * 文字单元 = 字素簇（Intl.Segmenter）：👩‍💻 这种 ZWJ 序列、带组合音标的 "e\u0301"
 * 都各算 1 个单元，因此它们永远不会被当成"两个中文字"。运行时不提供
 * Segmenter 时退回 code point 计数——那只会让 emoji 被多算（更保守，不会放宽）。
 */
export function countTextUnits(text: string): number {
  if (graphemeSegmenter !== null) {
    let graphemeCount = 0
    for (const _grapheme of graphemeSegmenter.segment(text)) graphemeCount += 1
    return graphemeCount
  }
  let textUnitCount = 0
  for (const _textUnit of text.matchAll(SINGLE_TEXT_UNIT_PATTERN)) textUnitCount += 1
  return textUnitCount
}

/** 输入是否全部由 CJK 文字组成（混排、emoji、ASCII 一律 false） */
export function isAllCjkText(text: string): boolean {
  return text.length > 0 && ALL_CJK_INPUT_PATTERN.test(text)
}

/** 触发建议所需的最短文字单元数；matcher 与 suggestion-store 共用此唯一判定 */
export function requiredInputUnitCount(trimmedInput: string, defaultMinChars: number): number {
  const effectiveDefaultMinChars = Math.max(1, Math.floor(defaultMinChars))
  if (isAllCjkText(trimmedInput)) return Math.min(effectiveDefaultMinChars, MIN_CJK_INPUT_UNITS)
  return effectiveDefaultMinChars
}

/** 输入是否达到触发阈值（同样按文字单元计数，不按 UTF-16 长度） */
export function meetsInputLengthRequirement(trimmedInput: string, defaultMinChars: number): boolean {
  if (trimmedInput.length === 0) return false
  return countTextUnits(trimmedInput) >= requiredInputUnitCount(trimmedInput, defaultMinChars)
}

/**
 * 三桶匹配核心（不做防御过滤，调用方需先 trim 输入）。
 * 候选最多取 maxCandidates 个，相关性依次为：前缀 > 子串 > fuzzy；
 * 每个桶内保持历史数组顺序（最新在前），不做二次排序。
 */
export function collectMatchBuckets(
  history: HistoryEntry[],
  trimmedInput: string,
  maxCandidates: number,
): MatchBuckets {
  const inputLower = trimmedInput.toLowerCase()
  const prefixMatches: HistoryEntry[] = []
  const substringMatches: HistoryEntry[] = []
  const unmatchedEntries: HistoryEntry[] = []
  for (const historyEntry of history) {
    if (historyEntry.text === trimmedInput) continue
    if (historyEntry.lower.startsWith(inputLower)) prefixMatches.push(historyEntry)
    else if (historyEntry.lower.includes(inputLower)) substringMatches.push(historyEntry)
    else unmatchedEntries.push(historyEntry)
  }
  const fuzzyMatches: HistoryEntry[] = []
  // 前两桶已够填满候选时跳过 fuzzy：合并后反正会被截断，省掉一次全量打分
  if (prefixMatches.length + substringMatches.length < maxCandidates) {
    const fuzzyResults = fuzzysort.go(inputLower, unmatchedEntries, {
      key: "lower",
      limit: maxCandidates,
    })
    for (const fuzzyResult of fuzzyResults) {
      if (fuzzyResult.obj !== undefined) fuzzyMatches.push(fuzzyResult.obj)
    }
  }
  return { prefix: prefixMatches, substring: substringMatches, fuzzy: fuzzyMatches }
}

export function findCandidates(
  history: HistoryEntry[],
  rawInput: string,
  options: MatchOptions,
): HistoryEntry[] {
  const minChars = options.minChars ?? DEFAULT_MIN_INPUT_CHARS
  const maxCandidates = options.maxCandidates ?? DEFAULT_MAX_CANDIDATES
  const excludePrefixes = options.excludePrefixes ?? DEFAULT_EXCLUDE_PREFIXES

  // 防御过滤：空 / 短于阈值（按文字单元）/ excludePrefixes 任一前缀命中
  const trimmedInput = rawInput.trim()
  if (!meetsInputLengthRequirement(trimmedInput, minChars)) return []
  if (maxCandidates <= 0) return []
  for (const excludePrefix of excludePrefixes) {
    if (excludePrefix.length > 0 && trimmedInput.startsWith(excludePrefix)) return []
  }

  const matchBuckets = collectMatchBuckets(history, trimmedInput, maxCandidates)

  // 合并：前缀 > 子串 > fuzzy（fuzzy 档内按分数降序），去重，截断 maxCandidates
  const seenTexts = new Set<string>()
  const mergedCandidates: HistoryEntry[] = []
  for (const historyEntry of [
    ...matchBuckets.prefix,
    ...matchBuckets.substring,
    ...matchBuckets.fuzzy,
  ]) {
    if (seenTexts.has(historyEntry.text)) continue
    seenTexts.add(historyEntry.text)
    mergedCandidates.push(historyEntry)
    if (mergedCandidates.length >= maxCandidates) break
  }
  return mergedCandidates
}