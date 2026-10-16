/**
 * opencode-history-ghost 核心单元测试（T16 P0，DESIGN §6）。
 *
 * 无测试框架：沿用 dev-smoke.ts 的风格——普通 TS 脚本 + 自写断言
 * （PASS/FAIL 逐行输出）+ 末尾汇总行 + 存在 FAIL 时非零退出码。
 * 必须同时兼容 bun 与 node(tsx) 双运行时：`bun test/ghost-core.test.ts`
 * 与 `npx tsx test/ghost-core.test.ts`。
 *
 * 5 个用例（oracle 第四轮审查 P0 清单）：
 *   1. suggestion-store：dismiss 只压制被取消的那一个输入；输入变化后立即恢复
 *      （dismissedForInput 单输入语义 + re-arm）。
 *   2. suggestion-store：增量快路径逐字延长输入时 candidates 数组引用严格不变、
 *      循环索引不变、仅 input 前移（防闪烁回归）。
 *   3. suggestion-store：N1 不变式——历史入库前已归一 trim（带尾随空白的原始
 *      文本经真实数据源后不带空白），evaluate(候选原文) 返回 null（完全相同排除，
 *      防"接受后同一条建议立即重弹"）。
 *   4. editor-bridge：同实例槽位覆写自愈——宿主覆写监听槽位后手动触发一轮身份
 *      轮询，宿主新监听器与我方 handler 都各恰好收到一次事件（经测试专用的
 *      runIntegrityPollOnce 暴露点驱动，见 editor-bridge.ts 头注释）。
 *   5. editor-bridge：Symbol 守卫——宿主把我方 wrapper 原样迁到新编辑器（不销毁
 *      槽位）后 adopt，一次事件宿主真正的监听器恰好执行一次（无嵌套放大、无丢失）。
 */

import * as nodeFs from "node:fs"
import * as nodeOs from "node:os"
import * as nodePath from "node:path"
import { createHistorySource, type HistoryEntry } from "../src/history-source"
import { createSuggestionStore, type HistoryGhostSettings } from "../src/suggestion-store"
import { createEditorBridge, runIntegrityPollOnce } from "../src/editor-bridge"

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

/** 测试用默认设置（与 DESIGN §3.8 默认值一致）。 */
function makeTestSettings(): HistoryGhostSettings {
  return {
    enabled: true,
    acceptKey: "tab",
    minChars: 3,
    maxCandidates: 5,
    maxEntries: 2000,
    maxTextLength: 2000,
    excludePrefixes: ["/", "@"],
  }
}

function makeHistoryEntry(text: string): HistoryEntry {
  return { text, lower: text.toLowerCase() }
}

/**
 * 假 EditBuffer：onContentChange/onCursorChange 是可读写属性（宿主真实行为
 * 是 getter/setter 对，测试只需可覆写的普通属性即可覆盖该形态）。
 */
interface MutableFakeEditBuffer {
  plainText: string
  cursorOffset: number
  replaceText(replacementText: string): void
  isDestroyed: boolean
  onContentChange: ((event: unknown) => void) | undefined
  onCursorChange: ((event: unknown) => void) | undefined
}

function makeFakeEditBuffer(
  initialText: string,
  hostContentChangeListener: ((event: unknown) => void) | undefined,
  hostCursorChangeListener: ((event: unknown) => void) | undefined,
): MutableFakeEditBuffer {
  return {
    plainText: initialText,
    cursorOffset: initialText.length,
    replaceText() {},
    isDestroyed: false,
    onContentChange: hostContentChangeListener,
    onCursorChange: hostCursorChangeListener,
  }
}

/** 可变焦点槽：宿主 renderer.currentFocusedEditor() 的可编程替身。 */
interface FocusedEditorHolder {
  editor: MutableFakeEditBuffer | null
}

function makeHostContext(holder: FocusedEditorHolder): unknown {
  return {
    renderer: {
      currentFocusedEditor: () => holder.editor,
    },
  }
}

const EDITOR_TEST_EVENT = { testEventMarker: "history-ghost-unit-test" }

/** 用例 1：dismiss 单输入压制 + 输入变化 re-arm。 */
function runDismissRearmScenario(): void {
  const storeHistory = [makeHistoryEntry("帮我写一个脚本"), makeHistoryEntry("帮我写一个模板")]
  const store = createSuggestionStore(() => storeHistory, makeTestSettings())
  const typedInput = "帮我写一"
  store.evaluate(typedInput)
  assertTruthy("dismiss 前应有建议", store.state() !== null)
  store.dismiss()
  assertTruthy("dismiss 后 state 应为 null", store.state() === null)
  store.evaluate(typedInput)
  assertTruthy("同输入 evaluate 后仍应为 null（dismissedForInput 单输入压制）", store.state() === null)
  store.evaluate(`${typedInput}个`)
  assertTruthy("改一字符后 evaluate 建议恢复（re-arm）", store.state() !== null)
}

/** 用例 2：增量快路径——candidates 引用严格不变、index 不变、仅 input 前移。 */
function runFastPathReferenceStabilityScenario(): void {
  const storeHistory = [makeHistoryEntry("hello world"), makeHistoryEntry("hello there")]
  const store = createSuggestionStore(() => storeHistory, makeTestSettings())
  store.evaluate("hel")
  const initialState = store.state()
  assertTruthy("初始 evaluate 应有建议", initialState !== null)
  if (!initialState) return
  store.cycle(1)
  const cycledState = store.state()
  assertTruthy("cycle 后应有建议", cycledState !== null)
  if (!cycledState) return
  store.evaluate("hell")
  const extendedState = store.state()
  assertTruthy("逐字延长后应有建议", extendedState !== null)
  if (!extendedState) return
  assertEqual(
    "快路径 candidates 数组引用严格不变（===，防闪烁回归）",
    extendedState.candidates,
    cycledState.candidates,
  )
  assertEqual("快路径 candidates 引用与 cycle 前也一致", extendedState.candidates, initialState.candidates)
  assertEqual("快路径循环索引不变", extendedState.index, cycledState.index)
  assertEqual("快路径仅 input 前移", extendedState.input, "hell")
}

/**
 * 用例 3（N1 不变式）：原始历史带尾随空白 → 真实数据源归一 trim 入库 →
 * evaluate(候选原文) 被完全相同排除，返回 null。
 */
async function runExactMatchExclusionScenario(): Promise<void> {
  const fixtureDirectory = nodePath.join(nodeOs.tmpdir(), "opencode-history-ghost-n1-test")
  const fixtureJsonlPath = nodePath.join(fixtureDirectory, "prompt-history.jsonl")
  try {
    nodeFs.mkdirSync(fixtureDirectory, { recursive: true })
    const rawFixtureText = "唯一候选句子带尾随空白  "
    nodeFs.writeFileSync(fixtureJsonlPath, `${JSON.stringify({ text: rawFixtureText })}\n`, "utf8")
    const historySource = createHistorySource({
      dataDirOverride: fixtureDirectory,
      maxEntries: 10,
      maxTextLength: 100,
    })
    await historySource.whenReady()
    const historyEntries = historySource.entries()
    assertEqual("夹具应产出 1 条历史", historyEntries.length, 1)
    assertTruthy(
      "入库文本应为 trim 后文本（存储层归一，无尾随空白）",
      historyEntries.length === 1 &&
        historyEntries[0].text === rawFixtureText.trim() &&
        historyEntries[0].text === "唯一候选句子带尾随空白",
    )
    const store = createSuggestionStore(() => historyEntries, makeTestSettings())
    store.evaluate("唯一候选句子带尾随空白")
    assertTruthy(
      "evaluate(候选原文) 应返回 null（完全相同排除——N1：接受后同条建议不重弹）",
      store.state() === null,
    )
  } finally {
    nodeFs.rmSync(fixtureDirectory, { recursive: true, force: true })
  }
}

/** 用例 4：同实例槽位覆写自愈——手动触发一轮身份轮询后事件不丢不重。 */
function runSlotOverwriteSelfHealScenario(): void {
  const originalContentListenerCalls = { count: 0 }
  const hostOriginalContentListener = (): void => {
    originalContentListenerCalls.count += 1
  }
  const holder: FocusedEditorHolder = {
    editor: makeFakeEditBuffer("hello", hostOriginalContentListener, () => {}),
  }
  const bridge = createEditorBridge(makeHostContext(holder))
  const inputNotifications = { count: 0 }
  bridge.onInput(() => {
    inputNotifications.count += 1
  })
  // 宿主在同一实例上覆写两个监听槽位（悄悄丢掉我们的 wrapper）
  const newHostContentListenerCalls = { count: 0 }
  holder.editor!.onContentChange = () => {
    newHostContentListenerCalls.count += 1
  }
  holder.editor!.onCursorChange = () => {}
  // 手动触发一轮身份轮询（与 watch() 的 1.5s 定时器运行同一函数体）
  runIntegrityPollOnce(bridge)
  holder.editor!.onContentChange!(EDITOR_TEST_EVENT)
  assertEqual("宿主新监听器恰好收到一次事件", newHostContentListenerCalls.count, 1)
  assertEqual("我方 handler 恰好收到一次通知", inputNotifications.count, 1)
  assertEqual(
    "被宿主覆写的陈旧 original 不再被调用（不恢复宿主已弃用的监听器）",
    originalContentListenerCalls.count,
    0,
  )
  bridge.dispose()
}

/** 用例 5：Symbol 守卫——wrapper 被宿主迁到新实例后 adopt，事件无嵌套放大。 */
function runWrapperMigrationGuardScenario(): void {
  const hostOriginalContentListenerCalls = { count: 0 }
  const hostOriginalContentListener = (): void => {
    hostOriginalContentListenerCalls.count += 1
  }
  const holder: FocusedEditorHolder = {
    editor: makeFakeEditBuffer("first", hostOriginalContentListener, () => {}),
  }
  const bridge = createEditorBridge(makeHostContext(holder))
  const inputNotifications = { count: 0 }
  bridge.onInput(() => {
    inputNotifications.count += 1
  })
  // 宿主把我们的 wrapper 原样迁移到新编辑器（不清理槽位），随后销毁旧实例
  const migratedEditor = makeFakeEditBuffer("migrated", undefined, undefined)
  migratedEditor.onContentChange = holder.editor!.onContentChange
  migratedEditor.onCursorChange = holder.editor!.onCursorChange
  holder.editor!.isDestroyed = true
  holder.editor = migratedEditor
  runIntegrityPollOnce(bridge)
  migratedEditor.onContentChange!(EDITOR_TEST_EVENT)
  assertEqual(
    "宿主真正的监听器恰好执行一次（无 wrapper 嵌套放大、无丢失）",
    hostOriginalContentListenerCalls.count,
    1,
  )
  assertEqual("我方 handler 恰好收到一次通知", inputNotifications.count, 1)
  bridge.dispose()
}

async function main(): Promise<void> {
  console.log("[1] suggestion-store：dismiss 单输入压制 + 改一字符恢复")
  runDismissRearmScenario()
  console.log("[2] suggestion-store：增量快路径 candidates 引用与索引不变")
  runFastPathReferenceStabilityScenario()
  console.log("[3] suggestion-store：N1 不变式（归一入库 + 完全相同排除）")
  await runExactMatchExclusionScenario()
  console.log("[4] editor-bridge：同实例槽位覆写自愈（手动触发一轮轮询）")
  runSlotOverwriteSelfHealScenario()
  console.log("[5] editor-bridge：Symbol 守卫防 wrapper 嵌套放大（宿主迁移场景）")
  runWrapperMigrationGuardScenario()
  console.log("----")
  if (failedAssertionCount === 0) {
    console.log("测试结论：全部 PASS")
  } else {
    console.log(`测试结论：存在 FAIL（${failedAssertionCount} 处断言失败，见上）`)
    process.exitCode = 1
  }
}

await main()
