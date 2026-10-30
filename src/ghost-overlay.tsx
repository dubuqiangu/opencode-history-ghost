// Text math and screen geometry for the inline ghost suffix (方案 B).
//
// Two layers, kept apart on purpose:
//   1. `computeInlineSuffix` — which characters has the user NOT typed yet?
//      Pure string work, unit-tested.
//   2. `resolveOverlayGeometry` — which screen cell does that suffix start at,
//      and how many cells may it occupy? This is only as good as the geometry
//      the host reports, so every field is validated and anything missing or
//      nonsensical yields null → the overlay stays hidden and the row above
//      the composer keeps being the suggestion surface.
//
// Nothing here renders, imports a solid primitive, or writes to the editor.

import { stringWidth } from "./string-width"

/** Read-only slice of a real TextareaRenderable this module consults. */
export interface TextareaGeometrySource {
  readonly plainText?: string
  readonly cursorOffset?: number
  readonly x?: number
  readonly y?: number
  readonly width?: number
  /** Paint-space origin (translate applied); preferred over x/y when finite. */
  readonly screenX?: number
  readonly screenY?: number
  /** Vertical scroll of the text view, in rows. */
  readonly scrollY?: number
  /** Logical caret from the native buffer (row/col in cells, offset in cells). */
  readonly logicalCursor?: { row?: number; col?: number; offset?: number }
  /**
   * VIEWPORT-RELATIVE caret (row/col in cells, wrap and scroll already applied).
   * Preferred over `logicalCursor − scroll`: the composer soft-wraps, so a
   * document-absolute logical row can name the wrong VISIBLE cell on a long
   * line. Present on every real EditBufferRenderable.
   */
  readonly visualCursor?: { visualRow?: number; visualCol?: number }
  readonly editBuffer?: { measureText?(text: string): number }
  /**
   * Legacy horizontal-scroll probe. The real editor does NOT expose this
   * (`EditBufferRenderable` exposes `editorView`), so it is only consulted on
   * the no-visualCursor fallback path and is expected to be absent.
   */
  readonly textBufferView?: { scrollX?: number }
  getPadding?(edge: number): { unit: number; value: number } | undefined
  readonly isDestroyed?: boolean
}

export interface InlineSuffix {
  /** Untyped remainder of the candidate on the caret's line; never spans lines. */
  readonly suffix: string
  /** Typed text on the caret's line, left of the caret. */
  readonly typedLinePrefix: string
  /** The candidate continues past this line (info only; we draw one line). */
  readonly continuesOnNextLine: boolean
}

export interface CaretCell {
  /** Line index in the buffer (0-based). */
  readonly row: number
  /** Column in display cells. */
  readonly col: number
}

export interface OverlayGeometry {
  /** Absolute screen cell of the suffix's first character. */
  readonly x: number
  readonly y: number
  /** Cells available between the suffix start and the textarea's right edge. */
  readonly availableCells: number
  /** The untyped remainder to paint on the caret's line. */
  readonly suffix: string
}

/** Yoga Point unit: the only padding unit that survives layout as a cell count. */
const YOGA_POINT_UNIT = 1

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value)
}

/** True when the caret sits inside the text at a valid offset. */
function isValidCaretOffset(typedText: string, caretOffset: unknown): caretOffset is number {
  return (
    typeof typedText === "string" &&
    Number.isSafeInteger(caretOffset) &&
    (caretOffset as number) >= 0 &&
    (caretOffset as number) <= typedText.length
  )
}

/**
 * Reads the caret line/column. Real editors report it directly; a fake editor
 * gets the same answer derived from its text and offset, so both paths share
 * one implementation.
 */
export function resolveCaretCell(editor: TextareaGeometrySource): CaretCell | null {
  const logicalCursor = editor.logicalCursor
  if (logicalCursor && Number.isSafeInteger(logicalCursor.row) && Number.isSafeInteger(logicalCursor.col)) {
    const row = logicalCursor.row as number
    const col = logicalCursor.col as number
    if (row >= 0 && col >= 0) return { row, col }
  }
  const typedText = editor.plainText
  const caretOffset = editor.cursorOffset
  if (!isValidCaretOffset(typedText ?? "", caretOffset)) return null
  const textBeforeCaret = (typedText as string).slice(0, caretOffset)
  const typedLinePrefix = textBeforeCaret.slice(textBeforeCaret.lastIndexOf("\n") + 1)
  return { row: textBeforeCaret.split("\n").length - 1, col: stringWidth(typedLinePrefix) }
}

/**
 * Splits the candidate into what the user already typed and what is still
 * missing, given the AUTHORITATIVE text left of the caret. The store matches on
 * the trimmed caret prefix, so the candidate begins with it; the suffix is
 * everything after that prefix, cut at the first newline because only the
 * caret's line can be covered.
 *
 * Takes the caret prefix as a STRING, not a numeric offset, on purpose: the
 * SDK's `cursorOffset` is a display-CELL value, and for CJK/emoji cells exceed
 * UTF-16 code units, so `text.slice(0, cursorOffset)` is wrong and no arithmetic
 * can recover the true boundary. Callers derive the prefix from the buffer
 * (`editBuffer.getTextRange(0, cursorOffset)`) and pass it here.
 *
 * Returns null when the candidate does not carry the typed prefix (stale state
 * within one tick) — drawing an unrelated tail would be worse than drawing
 * nothing for that frame.
 */
export function computeInlineSuffixFromPrefix(
  textBeforeCaret: string,
  candidateText: string,
): InlineSuffix | null {
  if (typeof candidateText !== "string" || candidateText.length === 0) return null
  if (typeof textBeforeCaret !== "string") return null
  const typedLinePrefix = textBeforeCaret.slice(textBeforeCaret.lastIndexOf("\n") + 1)
  // 匹配器用的是 trim 后的前缀，后缀要从候选里这段前缀之后开始切。
  const trimmedPrefix = textBeforeCaret.trim()
  // Compare an equal-length HEAD of the candidate instead of lowercasing the
  // whole string first: `toLowerCase()` can change length (e.g. "İ" → "i̇"), so
  // a `startsWith` on lowercased strings could pass while a slice by
  // `trimmedPrefix.length` cut at the wrong UTF-16 offset. Slicing the original
  // by the prefix length and comparing that exact head keeps the cut aligned.
  const candidateHead = candidateText.slice(0, trimmedPrefix.length)
  if (candidateHead.toLowerCase() !== trimmedPrefix.toLowerCase()) return null
  const remainder = candidateText.slice(trimmedPrefix.length)
  if (remainder.length === 0) return null
  const newlineIndex = remainder.indexOf("\n")
  const suffix = newlineIndex === -1 ? remainder : remainder.slice(0, newlineIndex)
  if (suffix.length === 0) return null
  return { suffix, typedLinePrefix, continuesOnNextLine: newlineIndex !== -1 }
}

/**
 * Code-unit convenience wrapper for FAKE editors whose `cursorOffset` counts
 * UTF-16 units (never the real SDK, where it counts display cells — use
 * `computeInlineSuffixFromPrefix` with a buffer-derived prefix there).
 */
export function computeInlineSuffix(
  typedText: string,
  caretOffset: number,
  candidateText: string,
): InlineSuffix | null {
  if (!isValidCaretOffset(typedText, caretOffset)) return null
  return computeInlineSuffixFromPrefix(typedText.slice(0, caretOffset), candidateText)
}

/** Padding of one edge in whole cells; null when the host does not expose it. */
function paddingCells(editor: TextareaGeometrySource, edge: number): number | null {
  if (typeof editor.getPadding !== "function") return null
  const paddingValue = editor.getPadding(edge)
  if (!paddingValue || paddingValue.unit !== YOGA_POINT_UNIT || !isFiniteNumber(paddingValue.value)) return null
  return Math.max(0, Math.trunc(paddingValue.value))
}

/**
 * Maps the caret to an absolute screen cell and budgets the suffix. Any
 * missing value returns null: the overlay then stays invisible and the row
 * above the input keeps carrying the suggestion.
 */
/**
 * Numeric layout value, tolerating the host's `"auto"` fallback.
 *
 * OpenTUI's width/height getters fall back to the styled dimension when the
 * layout value is still 0 (pre-layout frames), which yields the string
 * "auto". Treating that as "unknown" keeps the overlay hidden until a real
 * number arrives, instead of doing arithmetic on a string.
 */
function numericLayoutValue(value: unknown): number | null {
  if (isFiniteNumber(value)) return value
  return null
}

export function resolveOverlayGeometry(
  editor: TextareaGeometrySource,
  inlineSuffix: InlineSuffix,
  caretCell: CaretCell,
): OverlayGeometry | null {
  if (!editor || editor.isDestroyed === true) return null
  const textareaX = isFiniteNumber(editor.screenX) ? editor.screenX : numericLayoutValue(editor.x)
  const textareaY = isFiniteNumber(editor.screenY) ? editor.screenY : numericLayoutValue(editor.y)
  const textareaWidth = numericLayoutValue(editor.width)
  if (textareaX === null || textareaY === null) return null
  if (textareaWidth === null || textareaWidth <= 0) return null
  const paddingLeftCells = paddingCells(editor, 0)
  const paddingRightCells = paddingCells(editor, 2) ?? 0
  const paddingTopCells = paddingCells(editor, 1)
  if (paddingLeftCells === null || paddingTopCells === null) return null
  if (!Number.isSafeInteger(caretCell.row) || caretCell.row < 0) return null
  if (!isFiniteNumber(caretCell.col) || caretCell.col < 0) return null

  // Prefer the native VIEWPORT-RELATIVE caret. It already has soft-wrap and
  // scroll applied, so it names the correct on-screen cell on a long line; the
  // document-absolute `caretCell − scroll` path goes wrong once the composer
  // wraps. It also retires the old `textBufferView.scrollX` read, which is
  // always undefined on the real editor (`editorView` is the real property), so
  // the horizontal offset was silently 0.
  const visualCursor = editor.visualCursor
  const hasVisualCursor =
    visualCursor !== undefined &&
    Number.isSafeInteger(visualCursor.visualRow) &&
    Number.isSafeInteger(visualCursor.visualCol) &&
    (visualCursor.visualRow as number) >= 0 &&
    (visualCursor.visualCol as number) >= 0
  let screenRow: number
  let screenColumn: number
  if (hasVisualCursor) {
    screenRow = visualCursor!.visualRow as number
    screenColumn = visualCursor!.visualCol as number
  } else {
    // Fallback for editors without a visual cursor: document cell minus scroll.
    // A scroll value the host cannot report as a number means we cannot trust
    // the caret's on-screen position at all.
    if (editor.scrollY !== undefined && !isFiniteNumber(editor.scrollY)) return null
    if (editor.textBufferView?.scrollX !== undefined && !isFiniteNumber(editor.textBufferView.scrollX)) return null
    screenRow = caretCell.row - Math.max(0, Math.trunc(editor.scrollY ?? 0))
    screenColumn = caretCell.col - Math.max(0, Math.trunc(editor.textBufferView?.scrollX ?? 0))
  }

  const contentWidthCells = Math.trunc(textareaWidth) - paddingLeftCells - paddingRightCells
  if (contentWidthCells <= 0) return null

  const suffixStartColumn = paddingLeftCells + screenColumn
  const suffixStartRow = paddingTopCells + screenRow
  if (suffixStartColumn < 0) return null
  // The suffix must start inside the visible line band, otherwise the caret
  // is scrolled away and covering some other row would be actively wrong.
  // Height uses the same tolerant read: an "auto" value means the frame has
  // not been laid out yet, not that the caret is off-screen.
  const contentHeightCells = numericLayoutValue((editor as { height?: unknown }).height)
  if (contentHeightCells === null || suffixStartRow < 0 || suffixStartRow >= contentHeightCells) return null

  return {
    x: textareaX + suffixStartColumn,
    y: textareaY + suffixStartRow,
    availableCells: contentWidthCells - screenColumn,
    suffix: inlineSuffix.suffix,
  }
}
