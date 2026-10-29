// Display-cell width helpers for the inline ghost overlay.
//
// The composer is a real terminal editor: a CJK ideograph takes two cells, an
// emoji takes two, a tab advances to a tab stop, and one keypress can be a
// whole grapheme cluster ("👨‍👩‍👧‍👦", "e\u0301"). Counting UTF-16 code units
// would put the ghost suffix in the wrong column for all of those.
//
// Widths come from the terminal itself when it exposes a measurer (Bun's
// `Bun.stringWidth`); otherwise an approximate table is used, which is only
// ever wrong about *where* the suffix sits — never about whether it exists.

/** Tab stop width assumed for composer text (OpenTUI's edit buffer tab width). */
const TAB_CELL_WIDTH = 4

const ZERO_WIDTH_CODE_POINTS = new Set([0x200b, 0x200c, 0x200d, 0xfe0e, 0xfe0f])
const WIDE_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x1100, 0x115f],
  [0x2e80, 0x303e],
  [0x3041, 0x33ff],
  [0x3400, 0x4dbf],
  [0x4e00, 0x9fff],
  [0xa000, 0xa4cf],
  [0xac00, 0xd7a3],
  [0xf900, 0xfaff],
  [0xfe30, 0xfe4f],
  [0xff00, 0xff60],
  [0xffe0, 0xffe6],
  [0x1f004, 0x1f0cf],
  [0x1f300, 0x1f64f],
  [0x1f680, 0x1f6ff],
  [0x1f900, 0x1f9ff],
  [0x20000, 0x3fffd],
]

type GraphemeSegmenter = { segment(text: string): Iterable<{ segment: string }> }
let graphemeSegmenter: GraphemeSegmenter | null | undefined

/** Splits text into user-perceived characters; falls back to code points. */
export function splitGraphemes(text: string): string[] {
  if (!text) return []
  if (graphemeSegmenter === undefined) {
    const SegmenterConstructor = (Intl as unknown as {
      Segmenter?: new (locale?: string, options?: { granularity: string }) => GraphemeSegmenter
    }).Segmenter
    graphemeSegmenter = SegmenterConstructor ? new SegmenterConstructor(undefined, { granularity: "grapheme" }) : null
  }
  if (graphemeSegmenter) return Array.from(graphemeSegmenter.segment(text), (piece) => piece.segment)
  return Array.from(text)
}

/** Cell width of one grapheme cluster (a tab is charged its tab-stop width). */
export function graphemeWidth(grapheme: string): number {
  if (!grapheme) return 0
  if (grapheme === "\t") return TAB_CELL_WIDTH
  const codePoint = grapheme.codePointAt(0) ?? 0
  // Control characters and combining continuations occupy no cell of their own.
  if (codePoint < 0x20) return 0
  if (ZERO_WIDTH_CODE_POINTS.has(codePoint)) return 0
  const terminalWidth = (globalThis as { Bun?: { stringWidth?: (input: string) => number } }).Bun?.stringWidth
  if (typeof terminalWidth === "function") return terminalWidth(grapheme)
  return WIDE_RANGES.some(([rangeStart, rangeEnd]) => codePoint >= rangeStart && codePoint <= rangeEnd) ? 2 : 1
}

/** Total display-cell width of a string. */
export function stringWidth(text: string): number {
  let width = 0
  for (const grapheme of splitGraphemes(text)) width += graphemeWidth(grapheme)
  return width
}

/** Longest grapheme prefix of `text` that still fits in `cellBudget` cells. */
export function clampToCellBudget(text: string, cellBudget: number): string {
  if (!(cellBudget > 0)) return ""
  let usedCells = 0
  let keptText = ""
  for (const grapheme of splitGraphemes(text)) {
    const nextCellWidth = graphemeWidth(grapheme)
    if (usedCells + nextCellWidth > cellBudget) break
    usedCells += nextCellWidth
    keptText += grapheme
  }
  return keptText
}