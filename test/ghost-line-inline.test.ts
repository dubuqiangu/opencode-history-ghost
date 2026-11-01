/**
 * Inline ghost overlay tests (方案 B: absolute 覆盖层).
 *
 * 全部为合成数据：不读用户历史、不读配置、不依赖真实终端尺寸。
 * 覆盖三块：
 *   1. 后缀切分 —— 纯前缀 / 子串 / 多行 / CJK 双宽 / emoji 簇；
 *   2. 宽度截断 —— 绝不越出 textarea 右边界；
 *   3. 几何缺失降级 —— 任何一步拿不到信息都只是"不可见"，且不抛错；
 * 外加上方建议行（composer.top 那一行）的行为回归。
 *
 * 运行：bun test/ghost-line-inline.test.ts
 */

import { testRender, render } from "@opentui/solid"
import { BoxRenderable, TextareaRenderable } from "@opentui/core"
import { createGhostLine } from "../src/ghost-line"
import { createInlineGhostOverlay, fitSuffixToWidth, planInlineRender } from "../src/ghost-overlay-render"
import {
  computeInlineSuffix,
  resolveCaretCell,
  resolveOverlayGeometry,
  type TextareaGeometrySource,
} from "../src/ghost-overlay"
import { stringWidth } from "../src/string-width"
import { createSuggestionStore, type HistoryGhostSettings } from "../src/suggestion-store"

let failedAssertionCount = 0

function assertTrue(label: string, condition: boolean): void {
  console.log(`  ${condition ? "PASS" : "FAIL"}  ${label}`)
  if (!condition) failedAssertionCount += 1
}

function assertEqual<T>(label: string, actualValue: T, expectedValue: T): void {
  const matches = actualValue === expectedValue
  const detail = matches ? "" : `（actual=${JSON.stringify(actualValue)} expected=${JSON.stringify(expectedValue)}）`
  console.log(`  ${matches ? "PASS" : "FAIL"}  ${label}${detail}`)
  if (!matches) failedAssertionCount += 1
}

// The highlight region (typedMatch) is painted in base color while everything
// else is dim "gray". Extract just the highlighted text from a rendered line so
// tests can assert exactly which segment is emphasised, not merely the blob text.
type RenderedSpan = { text: string; fg: { buffer: ArrayLike<number> } }
function extractHighlightText(line: { spans: RenderedSpan[] }): string {
  return line.spans
    .filter((span) => !(span.fg.buffer[0] === 128 && span.fg.buffer[1] === 128 && span.fg.buffer[2] === 128))
    .map((span) => span.text)
    .join("")
    .trim()
}

function makeTestSettings(): HistoryGhostSettings {
  return {
    enabled: true,
    acceptKey: "tab",
    minChars: 3,
    maxCandidates: 10,
    maxEntries: 2000,
    maxTextLength: 2000,
    excludePrefixes: ["/", "@"],
  }
}

/** Minimal geometry source: only the fields a layout-aware textarea reports. */
function makeGeometrySource(overrides: Partial<TextareaGeometrySource>): TextareaGeometrySource {
  return {
    plainText: "",
    cursorOffset: 0,
    screenX: 2,
    screenY: 4,
    width: 40,
    height: 3,
    scrollY: 0,
    textBufferView: { scrollX: 0 },
    getPadding: (edge: number) => (edge === 0 ? { unit: 1, value: 1 } : edge === 1 ? { unit: 1, value: 1 } : { unit: 1, value: 0 }),
    ...overrides,
  }
}

// ---------------------------------------------------------------- 1. 后缀切分

function runSuffixSplittingCases(): void {
  // 纯前缀匹配：输入是候选的开头，后缀就是剩下的部分。
  const prefixCase = computeInlineSuffix("帮我写", 3, "帮我写一个脚本")
  assertEqual("前缀匹配：后缀为剩余文本", prefixCase?.suffix, "一个脚本")
  assertEqual("前缀匹配：光标所在行已输入部分", prefixCase?.typedLinePrefix, "帮我写")
  assertEqual("前缀匹配：未跨行", prefixCase?.continuesOnNextLine, false)

  // 子串匹配：宿主的候选来自 fuzzysort，可能不是从第 0 个字符开始；但存储层
  // 的 state.input 是 trim 后的光标前缀，所以只有前缀一致的候选才画后缀。
  const substringCase = computeInlineSuffixes("写一个", "帮我写一个脚本")
  assertEqual("子串（非前缀）候选不画后缀", substringCase, null)

  // 多行：只画光标那一行，遇到换行就停。
  const multilineTyped = "第一行内容\n第二行"
  const multilineCase = computeInlineSuffix(multilineTyped, multilineTyped.length, "第一行内容\n第二行继续往下写\n第三行")
  assertEqual("多行：只取光标所在行的后缀", multilineCase?.suffix, "继续往下写")
  assertEqual("多行：已输入部分为光标所在行前缀", multilineCase?.typedLinePrefix, "第二行")
  assertEqual("多行：标记还有后续行", multilineCase?.continuesOnNextLine, true)

  // CJK 双宽：宽度按显示格算，"你好"是 4 格而不是 2。
  assertEqual("CJK 双宽：前缀宽度为 4 格", stringWidth("你好"), 4)
  const cjkCase = computeInlineSuffix("你好世", 3, "你好世界和平")
  assertEqual("CJK：后缀正确", cjkCase?.suffix, "界和平")

  // emoji：ZWJ 家庭 emoji 是一个簇，宽度 2，不能按码点拆。
  const emojiCase = computeInlineSuffix("提交🎉", "提交🎉".length, "提交🎉🎉完成")
  assertEqual("emoji：后缀不含已输入的那一个", emojiCase?.suffix, "🎉完成")
  const familyEmoji = "👨‍👩‍👧‍👦"
  assertEqual("emoji：ZWJ 家庭簇宽度为 2", stringWidth(familyEmoji), 2)
  assertEqual("emoji：家庭簇算一个光标位置", stringWidth(familyEmoji), 2)

  // 制表符：按 tab stop 计宽，否则后缀会凸到光标左边。
  assertTrue("制表符宽度为正（按 tab stop 计）", stringWidth("\t") >= 1)

  // 陈旧状态：候选不以已输入前缀开头 → 不画（宁可不显示，也不画错位尾巴）。
  assertEqual("候选不以前缀开头时返回 null", computeInlineSuffix("abc", 3, "xyzabc"), null)
  // 光标在文本中间：后缀从光标处开始，而不是从整个输入末尾。
  const midCaret = computeInlineSuffix("帮我写一个", 3, "帮我写一个脚本")
  assertEqual("光标在中间：后缀从光标处切", midCaret?.suffix, "一个脚本")
  // 光标越界 / 非法 offset：不画。
  assertEqual("offset 越界返回 null", computeInlineSuffix("abc", 99, "abcdef"), null)
  assertEqual("offset 为负返回 null", computeInlineSuffix("abc", -1, "abcdef"), null)
  // 已完全输入（候选与输入相同）：没有后缀可画。
  assertEqual("完全输入时没有后缀", computeInlineSuffix("abcdef", 6, "abcdef"), null)
}

/** 小工具：把"是否命中前缀"的判定单独拎出来读。 */
function computeInlineSuffixes(typedText: string, candidateText: string): string | null {
  const result = computeInlineSuffix(typedText, typedText.length, candidateText)
  return result ? result.suffix : null
}

// ---------------------------------------------------------------- 2. 宽度截断

function runWidthClampingCases(): void {
  assertEqual("放得下时原样返回", fitSuffixToWidth("脚本", 10), "脚本")
  assertEqual("恰好放满时原样返回", fitSuffixToWidth("脚本", 4), "脚本")
  assertEqual("预算为 0 时不画", fitSuffixToWidth("脚本", 0), "")
  assertEqual("预算为负时不画", fitSuffixToWidth("脚本", -3), "")

  const clamped = fitSuffixToWidth("一二三四五六七八", 5)
  assertTrue("截断后带省略号", clamped.endsWith("…"))
  assertTrue("截断后宽度不超过预算", stringWidth(clamped) <= 5)

  // 预算只够一个双宽字 + 省略号（3 格）：不能把双宽字劈成一半。
  const tightClamp = fitSuffixToWidth("一二三四", 3)
  assertTrue("双宽字不被劈开且不越界", stringWidth(tightClamp) <= 3)
  assertEqual("预算 3 格留出省略号位置", tightClamp, "一…")

  // 预算 2 格：只有一个双宽字的位置，省略号反而放不下时宁可不画省略号。
  const onlyWide = fitSuffixToWidth("一二三四", 2)
  assertTrue("预算 2 格时宽度不越界", stringWidth(onlyWide) <= 2)
}

// ---------------------------------------------------------------- 3. 几何与降级

function runGeometryCases(): void {
  const source = makeGeometrySource({ plainText: "你好ab", cursorOffset: 4 })
  const inlineSuffix = computeInlineSuffix("你好ab", 4, "你好abc")
  const caretCell = resolveCaretCell(source)
  assertEqual("光标行号", caretCell?.row, 0)
  assertEqual("光标列（CJK 双宽）", caretCell?.col, 6)

  const geometry = inlineSuffix && caretCell ? resolveOverlayGeometry(source, inlineSuffix, caretCell) : null
  assertTrue("几何可解析", geometry !== null)
  assertEqual("后缀起点 x = screenX + paddingLeft + 光标列", geometry?.x, 2 + 1 + 6)
  assertEqual("后缀起点 y = screenY + paddingTop + 光标行", geometry?.y, 4 + 1 + 0)
  assertEqual("可用格数 = 内容宽 - 光标列", geometry?.availableCells, 39 - 6)

  // 多行：光标在第 2 行，y 要跟着行号走。
  const multilineSource = makeGeometrySource({ plainText: "第一行\n第二行", cursorOffset: 7 })
  const multilineCaret = resolveCaretCell(multilineSource)
  assertEqual("多行光标行号", multilineCaret?.row, 1)
  const multilineGeometry =
    multilineCaret ? resolveOverlayGeometry(multilineSource, { suffix: "X", typedLinePrefix: "第二行", continuesOnNextLine: false }, multilineCaret) : null
  assertEqual("多行光标 y 跟随行号", multilineGeometry?.y, 4 + 1 + 1)

  // ---- 降级：任何一项几何缺失都只是"不可见"，不抛错。
  const targetSuffix = { suffix: "一个脚本", typedLinePrefix: "帮我写", continuesOnNextLine: false }
  const targetCaret = { row: 0, col: 3 }
  const missingScreenOrigin = resolveOverlayGeometry(
    makeGeometrySource({ screenX: undefined, x: undefined }),
    targetSuffix,
    targetCaret,
  )
  assertEqual("缺 screenX/x → 降级为 null", missingScreenOrigin, null)
  const zeroWidth = resolveOverlayGeometry(makeGeometrySource({ width: 0 }), targetSuffix, targetCaret)
  assertEqual("宽度为 0 → 降级为 null", zeroWidth, null)
  const undefinedWidth = resolveOverlayGeometry(makeGeometrySource({ width: undefined }), targetSuffix, targetCaret)
  assertEqual("宽度为 undefined → 降级为 null", undefinedWidth, null)
  // Padding is a soft inset: unknown or unparseable padding degrades to 0 (the
  // suffix is positioned from the editor's own screen origin) rather than
  // hiding the overlay. This is the real-machine fix — the prompt textarea sets
  // its padding via shorthand, so `getPadding(Left)` is Unit.Undefined and the
  // old hard-fail kept the grey suffix permanently invisible.
  const noPadding = resolveOverlayGeometry(makeGeometrySource({ getPadding: undefined }), targetSuffix, targetCaret)
  assertEqual("拿不到 padding → 按 0 起算仍能解析", noPadding?.x, makeGeometrySource({}).screenX! + 0 + 3)
  assertEqual("拿不到 padding → 按 0 起算仍能解析 (y)", noPadding?.y, makeGeometrySource({}).screenY! + 0 + 0)
  const percentPadding = resolveOverlayGeometry(
    makeGeometrySource({ getPadding: () => ({ unit: 2, value: 50 }) }),
    targetSuffix,
    targetCaret,
  )
  assertEqual("百分比 padding 无法解析 → 按 0 起算仍能解析", percentPadding?.x, makeGeometrySource({}).screenX! + 0 + 3)
  const destroyedEditor = resolveOverlayGeometry(makeGeometrySource({ isDestroyed: true }), targetSuffix, targetCaret)
  assertEqual("编辑器已销毁 → 降级为 null", destroyedEditor, null)
  const badScroll = resolveOverlayGeometry(makeGeometrySource({ scrollY: Number.NaN }), targetSuffix, targetCaret)
  assertEqual("滚动值非法 → 降级为 null", badScroll, null)
  const scrolledAway = resolveOverlayGeometry(makeGeometrySource({ scrollY: 9 }), targetSuffix, targetCaret)
  assertEqual("光标被滚出可视区 → 降级为 null", scrolledAway, null)

  // ---- planInlineRender：把"不可见"的每种理由都走一遍。
  const emptyHistory: never[] = []
  const planStore = createSuggestionStore(() => emptyHistory, makeTestSettings())
  assertEqual("没有建议状态时不画", planInlineRender(planStore, null), null)
  assertEqual("没有编辑器来源时不画", planInlineRender(planStore, { currentEditor: () => null }), null)
}

// ---------------------------------------------------------------- 4. 上方行回归

/**
 * 回归：不注入 editorSource 时，上方建议行必须与以前完全一样——这是覆盖层
 * 失败时用户仍然看得到建议的依据。
 */
async function runGhostRowRegression(): Promise<void> {
  const historyEntries = [
    { text: "hello original candidate", lower: "hello original candidate" },
    { text: "world replacement candidate", lower: "world replacement candidate" },
  ]
  const rowStore = createSuggestionStore(() => historyEntries, makeTestSettings())
  rowStore.evaluate("hel")
  const ghostLine = createGhostLine({ store: rowStore, settings: makeTestSettings(), theme: undefined })
  assertTrue("未注入编辑器来源时不生成覆盖层", ghostLine.renderInlineOverlay() === null)

  const setup = await testRender(() => ghostLine.renderRow(), { width: 110, height: 8 })
  try {
    await setup.renderOnce()
    const initialFrame = setup.captureCharFrame()
    assertTrue("上方行显示候选原文", initialFrame.includes("hello original candidate"))
    assertTrue("上方行显示接受提示", initialFrame.includes("Tab 接受"))

    // tleclaire preview.ts borrow: a pasted first line with a run of
    // whitespace is collapsed to single spaces on display, so it cannot flood
    // the row's layout. Accepting still inserts the full text — the store
    // entry is untouched, only the row's visual projection collapses.
    const blobHistory = [
      { text: "git   push   --force   origin   main", lower: "git   push   --force   origin   main" },
    ]
    const blobStore = createSuggestionStore(() => blobHistory, makeTestSettings())
    blobStore.evaluate("git")
    const blobGhostLine = createGhostLine({ store: blobStore, settings: makeTestSettings(), theme: undefined })
    const blobSetup = await testRender(() => blobGhostLine.renderRow(), { width: 110, height: 8 })
    try {
      await blobSetup.renderOnce()
      const blobFrame = blobSetup.captureCharFrame()
      assertTrue("内嵌空白压成单空格（防撑爆布局）", blobFrame.includes("git push --force origin main"))
      assertTrue("内嵌空白压成单空格（不保留双空格）", !blobFrame.includes("git  push"))
      // The rendered row is display-only: the candidate text itself is intact.
      assertEqual("候选原文未被压空格（接受仍插入原文）", blobStore.current()?.text, "git   push   --force   origin   main")
    } finally {
      blobSetup.renderer.destroy()
    }

    // Regression (P1-1): after the whitespace run collapses to one space, the
    // highlight region must be computed against the SAME collapsed line that is
    // sliced. Previously matchStart came from the uncollapsed candidate, so a
    // substring match after a whitespace run mis-aligned the split (it cut the
    // word mid-way). A substring input that itself contained a space got -1 and
    // dropped the highlight entirely. Both must now emphasise the full word.
    const substringBlob = [
      { text: "git   push --force origin main", lower: "git   push --force origin main" },
    ]
    const substringStore = createSuggestionStore(() => substringBlob, makeTestSettings())
    substringStore.evaluate("push")
    const substringGhostLine = createGhostLine({ store: substringStore, settings: makeTestSettings(), theme: undefined })
    const substringSetup = await testRender(() => substringGhostLine.renderRow(), { width: 110, height: 8 })
    try {
      await substringSetup.renderOnce()
      const substringLine = substringSetup.captureSpans().lines[0]
      assertTrue("子串命中整词高亮（空白折叠后仍对齐）", extractHighlightText(substringLine) === "push")
      assertTrue("高亮不把词从中间劈开（leadingDim 不含断词）", !extractHighlightText(substringLine).startsWith("git"))
    } finally {
      substringSetup.renderer.destroy()
    }

    const spacedInputBlob = [
      { text: "apt   install", lower: "apt   install" },
    ]
    const spacedInputStore = createSuggestionStore(() => spacedInputBlob, makeTestSettings())
    spacedInputStore.evaluate("apt i")
    const spacedInputGhostLine = createGhostLine({ store: spacedInputStore, settings: makeTestSettings(), theme: undefined })
    const spacedInputSetup = await testRender(() => spacedInputGhostLine.renderRow(), { width: 110, height: 8 })
    try {
      await spacedInputSetup.renderOnce()
      const spacedInputLine = spacedInputSetup.captureSpans().lines[0]
      assertTrue("含空格的输入仍产生高亮（不再全灰）", extractHighlightText(spacedInputLine) === "apt i")
    } finally {
      spacedInputSetup.renderer.destroy()
    }

    rowStore.evaluate("wor")
    ghostLine.refresh()
    await setup.renderOnce()
    const updatedFrame = setup.captureCharFrame()
    assertTrue("切换候选后上方行更新", updatedFrame.includes("world replacement candidate"))
    assertTrue("旧候选不再出现在上方行", !updatedFrame.includes("hello original candidate"))

    rowStore.clear()
    ghostLine.refresh()
    await setup.renderOnce()
    assertTrue("清空建议后上方行收起", !setup.captureCharFrame().includes("world replacement candidate"))
  } finally {
    setup.renderer.destroy()
  }
}

/**
 * 覆盖层挂载冒烟：注入一个真实的、已经过布局的 textarea，确认 overlay 树能
 * 被 host 挂上并在 refresh() 时不抛错。这里只验证"不崩"，位置正确性属于真机
 * 验收范围（见报告）。
 */
async function runOverlaySmoke(): Promise<void> {
  const setup = await testRender(() => null, { width: 80, height: 10 })
  const { renderer } = setup
  try {
    const textarea = new TextareaRenderable(renderer, { id: "smoke-composer", width: 40, height: 3, paddingLeft: 1, paddingTop: 1 })
    const promptRoot = new BoxRenderable(renderer, { id: "smoke-root" })
    promptRoot.add(textarea)
    renderer.root.add(promptRoot)
    textarea.focus()
    textarea.insertText("hel")
    await setup.renderOnce()

    const smokeHistory = [{ text: "hello smoke candidate", lower: "hello smoke candidate" }]
    const smokeStore = createSuggestionStore(() => smokeHistory, makeTestSettings())
    smokeStore.evaluate("hel")
    const overlay = createInlineGhostOverlay({
      store: smokeStore,
      editorSource: { currentEditor: () => textarea as unknown as any },
      theme: undefined,
    })
    await render(() => overlay.renderOverlay(), renderer)
    await setup.renderOnce()
    overlay.refresh()
    await setup.renderOnce()
    // Assert on the rendered CELL FRAME, not just "did not throw": the whole
    // anchor → absolute box → text chain must actually paint the untyped
    // remainder. (The old smoke test asserted `true`, so a total rendering
    // regression would still have passed.)
    const paintedFrame = setup.captureCharFrame()
    const painted = paintedFrame.includes("lo smoke candidate")
    if (!painted) {
      console.log("  ---- captured frame (overlay not found) ----")
      for (const line of paintedFrame.split("\n")) console.log("  |" + line + "|")
      console.log("  ------------------------------------------")
    }
    assertTrue("覆盖层在真实 textarea 上挂载并绘制出灰字后缀", painted)
    assertTrue("覆盖层在真实 textarea 上挂载并 refresh 不抛错", true)
    smokeStore.clear()
    overlay.refresh()
    await setup.renderOnce()
    assertTrue("建议消失后覆盖层 refresh 仍不抛错", true)
    assertTrue("建议消失后灰字后缀从帧中消失", !setup.captureCharFrame().includes("lo smoke candidate"))
  } finally {
    setup.renderer.destroy()
  }
}

// ---------------------------------------------- 6. 真机坐标：cursorOffset 是显示格

/**
 * 回归：真机 textarea 的 `cursorOffset` 是“显示格”，不是 UTF-16 码元。对 CJK/emoji，
 * 格数 > 码元数，若按 `plainText.slice(0, cursorOffset)` 切就会越界 → 覆盖层永久隐藏
 * （用户真机症状：灰色建议只出现在输入框上方）。这里用一个“格偏移 + editBuffer 映射”
 * 的仿真编辑器锁定新路径必须产出后缀。
 */
function sliceByDisplayCells(text: string, startCell: number, endCell: number): string {
  let cellCursor = 0
  let sliced = ""
  for (const character of Array.from(text)) {
    const characterWidth = stringWidth(character)
    const nextCell = cellCursor + characterWidth
    if (nextCell > startCell && cellCursor < endCell) sliced += character
    cellCursor = nextCell
    if (cellCursor >= endCell) break
  }
  return sliced
}

function runCellOffsetPlanCases(): void {
  const cjkHistory = [{ text: "你好世界和平", lower: "你好世界和平" }]
  const cjkStore = createSuggestionStore(() => cjkHistory, makeTestSettings())
  cjkStore.evaluate("你好世")
  const cjkEditor = {
    plainText: "你好世", // 3 UTF-16 code units
    cursorOffset: 6, // 6 display cells — the real SDK convention
    isDestroyed: false,
    logicalCursor: { row: 0, col: 6 },
    screenX: 2,
    screenY: 4,
    width: 40,
    height: 3,
    scrollY: 0,
    textBufferView: { scrollX: 0 },
    getPadding: (edge: number) => (edge === 0 || edge === 1 ? { unit: 1, value: 1 } : { unit: 1, value: 0 }),
    editBuffer: {
      measureText: (text: string) => stringWidth(text),
      getTextRange: (startCell: number, endCell: number) => sliceByDisplayCells("你好世", startCell, endCell),
    },
  }
  const cjkPlan = planInlineRender(cjkStore, { currentEditor: () => cjkEditor as unknown as any })
  assertEqual("格偏移 CJK 前缀产出后缀（修复前为 null）", cjkPlan?.text, "界和平")
  assertEqual("格偏移 CJK 后缀起点 x", cjkPlan?.x, 2 + 1 + 6)

  // 真机意外缺失 logicalCursor 时，也必须能靠权威前缀推出光标格。
  const editorWithoutLogicalCursor = { ...cjkEditor, logicalCursor: undefined }
  const fallbackPlan = planInlineRender(cjkStore, { currentEditor: () => editorWithoutLogicalCursor as unknown as any })
  assertEqual("缺 logicalCursor 仍由前缀推出光标格", fallbackPlan?.text, "界和平")

  // ASCII 控制组：格 == 码元，新旧坐标一致。
  const asciiHistory = [{ text: "hello there", lower: "hello there" }]
  const asciiStore = createSuggestionStore(() => asciiHistory, makeTestSettings())
  asciiStore.evaluate("hel")
  const asciiEditor = {
    ...cjkEditor,
    plainText: "hel",
    cursorOffset: 3,
    logicalCursor: { row: 0, col: 3 },
    editBuffer: {
      measureText: (text: string) => stringWidth(text),
      getTextRange: (startCell: number, endCell: number) => sliceByDisplayCells("hel", startCell, endCell),
    },
  }
  const asciiPlan = planInlineRender(asciiStore, { currentEditor: () => asciiEditor as unknown as any })
  assertEqual("ASCII 控制组：后缀正确", asciiPlan?.text, "lo there")

  // B1 回归：logicalCursor 与权威前缀不一致（滚动/换行边界）时，位置必须跟随
  // 前缀而非 logicalCursor，否则会在错误的格子上画另一段尾巴，或直接判 null。
  const mismatchedCaretEditor = { ...cjkEditor, logicalCursor: { row: 0, col: 99 } }
  const mismatchedPlan = planInlineRender(cjkStore, { currentEditor: () => mismatchedCaretEditor as unknown as any })
  assertEqual("logicalCursor 与真实前缀不一致时按前缀定位 x", mismatchedPlan?.x, 2 + 1 + 6)

  // B2 回归：真机 composer 会软换行，光标应取 visualCursor（视口相对，已含换行与滚动），
  // 必须优先于文档绝对的 logicalCursor，否则长行上会定位到错误的可见行。
  const wrappedEditor = {
    ...cjkEditor,
    logicalCursor: { row: 5, col: 60 },
    visualCursor: { visualRow: 1, visualCol: 6 },
  }
  const wrappedPlan = planInlineRender(cjkStore, { currentEditor: () => wrappedEditor as unknown as any })
  assertEqual("软换行按 visualCursor 定位 x", wrappedPlan?.x, 2 + 1 + 6)
  assertEqual("软换行按 visualCursor 定位 y", wrappedPlan?.y, 4 + 1 + 1)
}

async function main(): Promise<void> {
  console.log("[1] 后缀切分：前缀 / 子串 / 多行 / CJK / emoji")
  runSuffixSplittingCases()
  console.log("[2] 宽度截断不越界")
  runWidthClampingCases()
  console.log("[3] 光标单元格、覆盖层几何与几何缺失降级")
  runGeometryCases()
  console.log("[4] 上方建议行回归（无覆盖层时行为不变）")
  await runGhostRowRegression()
  console.log("[5] 覆盖层挂载冒烟（真实 textarea）")
  await runOverlaySmoke()
  console.log("[6] 真机坐标：cursorOffset 显示格 + editBuffer 映射（CJK 覆盖层可见性）")
  runCellOffsetPlanCases()
  console.log("----")
  if (failedAssertionCount === 0) {
    console.log("测试结论：全部 PASS")
  } else {
    console.log(`测试结论：存在 FAIL（${failedAssertionCount} 处断言失败，见上）`)
    process.exitCode = 1
  }
}

await main()
