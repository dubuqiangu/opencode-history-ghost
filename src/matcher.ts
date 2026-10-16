/**
 * opencode-history-ghost 匹配引擎（DESIGN §3.2）。
 *
 * 纯函数、无状态：前缀桶 > 子串桶 > fuzzy 桶，档内最新优先（即数组顺序），
 * 合并去重后截断到 maxCandidates。增量快路径不在这里（由 suggestion-store 处理）。
 *
 * fuzzysort 用法按 v4.0.2 实测 API：
 *   fuzzysort.go(inputLower, 对象数组, { key: "lower", limit })
 *   → KeyResults（含 .obj 原对象 / .score，已按分数降序）。
 */

import type { HistoryEntry } from "./history-source"
import fuzzysort from "fuzzysort"

export interface MatchOptions {
  /** 触发最小输入长度，默认 3（兼作防抖） */
  minChars?: number
  /** 候选上限，默认 5 */
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
const DEFAULT_MAX_CANDIDATES = 5
const DEFAULT_EXCLUDE_PREFIXES: readonly string[] = ["/", "@"]

/**
 * 三桶匹配核心（不做防御过滤，调用方需先 trim 输入）。
 * 与当前输入完全相同的候选不出现在任何桶中（不建议整句重复）。
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

  // 防御过滤：空 / 短于 minChars / excludePrefixes 任一前缀命中
  const trimmedInput = rawInput.trim()
  if (trimmedInput.length < minChars) return []
  for (const excludePrefix of excludePrefixes) {
    if (excludePrefix.length > 0 && trimmedInput.startsWith(excludePrefix)) return []
  }

  const matchBuckets = collectMatchBuckets(history, trimmedInput, maxCandidates)

  // 合并：前缀 > 子串 > fuzzy（分数降序），去重，截断 maxCandidates
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
