/** @jsxImportSource @opentui/solid */
// Renders the inline ghost suffix over the composer (方案 B: absolute 覆盖层).
//
// This file owns exactly one line of one renderable: a static `text` node
// nested inside a zero-size anchor box claimed on the composer region, with
// position:absolute on the inner box. refresh() recomputes the caret cell and
// the suffix text and writes them onto that node; it never creates, destroys or
// re-mounts anything, so the host's reconciler never sees us churn and layout
// cost stays at one node.
//
// Why a composer-region anchor: the textarea lives under the session slot tree
// and we cannot add a child to it. A slot render returns one JSX element, so
// the root is an IN-FLOW zero-size box; its screen origin IS the composer
// region's origin, and the absolutely-positioned suffix child is inset relative
// to it. (The old app-slot approach anchored an absolute node to the app
// container, which lays out in normal flow at the bottom of the main column —
// so the suffix landed off-screen.)
//
// Degradation contract: planInlineRender() returns null whenever the editor
// instance, its geometry or the store state is unusable. The overlay then sets
// visible=false and does nothing else — no throw, no warning spam, and the row
// above the composer keeps showing the suggestion.

import type { EditBufferLike } from "./editor-bridge"
import type { SuggestionStoreApi } from "./suggestion-store"
import { clampToCellBudget, stringWidth } from "./string-width"
import { computeInlineSuffixFromPrefix, resolveOverlayGeometry, type CaretCell } from "./ghost-overlay"

/** Character kept before the truncation mark when the suffix overflows. */
const ELLIPSIS = "…"

/** Access to the trusted composer textarea, injected by the assembly layer. */
export interface InlineEditorSource {
  /** The proven composer textarea, or null when the composer is not proven. */
  currentEditor(): (EditBufferLike & Record<string, unknown>) | null
}

/** Structural slice of a TextRenderable this controller patches. */
interface OverlayTextRenderable {
  content: string
  visible: boolean
  readonly isDestroyed: boolean
}

export interface InlineGhostOverlayApi {
  /** Static overlay node for the `app` slot; safe to call while evaluating. */
  renderOverlay(): unknown
  /** Recomputes geometry and suffix text from the store's current state. */
  refresh(): void
}

export interface InlineGhostOverlayDeps {
  readonly store: SuggestionStoreApi
  readonly editorSource: InlineEditorSource | null
  /** ResolvedTheme from the plugin context; accessed defensively. */
  readonly theme: unknown
}

export interface InlineRenderPlan {
  readonly text: string
  readonly x: number
  readonly y: number
}

/** Fits the suffix into the cells left of the textarea's right edge. */
export function fitSuffixToWidth(suffix: string, availableCells: number): string {
  if (availableCells <= 0) return ""
  const keptText = clampToCellBudget(suffix, availableCells)
  if (keptText.length === suffix.length) return keptText
  if (keptText.length === 0) return ""
  // The cut squeezed the ellipsis out; retry one cell narrower so it fits.
  const keptWithRoomForEllipsis = clampToCellBudget(suffix, availableCells - 1)
  if (keptWithRoomForEllipsis.length === 0) return ""
  return `${keptWithRoomForEllipsis}${ELLIPSIS}`
}

/**
 * The authoritative text left of the caret. The SDK's `cursorOffset` counts
 * DISPLAY CELLS: for CJK/emoji it exceeds the UTF-16 code-unit length, so
 * `plainText.slice(0, cursorOffset)` is wrong and no arithmetic recovers the
 * boundary. The native buffer converts cells → real text; fake editors without
 * a buffer keep their code-unit convention. Null when neither can be trusted
 * (the overlay then stays hidden and the row above carries the suggestion).
 */
function resolveCaretPrefixText(editor: EditBufferLike & Record<string, unknown>): string | null {
  const offset = editor.cursorOffset
  if (typeof offset !== "number" || !Number.isSafeInteger(offset) || offset < 0) return null
  const buffer = editor.editBuffer
  if (buffer && typeof buffer.getTextRange === "function" && typeof buffer.measureText === "function") {
    try {
      const text = editor.plainText
      if (typeof text !== "string") return null
      const end = buffer.measureText(text)
      if (offset > end) return null
      const prefix = buffer.getTextRange(0, offset)
      // Mirror the bridge's invariant: the split must be lossless.
      if (prefix + buffer.getTextRange(offset, end) !== text) return null
      return prefix
    } catch {
      // A host that refuses these reads leaves the prefix unknown → hidden.
      return null
    }
  }
  const plainText = editor.plainText
  if (typeof plainText === "string" && offset <= plainText.length) return plainText.slice(0, offset)
  return null
}

/**
 * Caret line/column derived from the authoritative prefix string. Used only
 * when the editor reports no `logicalCursor`: without it, a cell-valued
 * `cursorOffset` on a CJK editor had no valid cell and the overlay stayed
 * hidden. `stringWidth` restores the display-cell column.
 */
function caretCellFromPrefix(textBeforeCaret: string): CaretCell {
  const lastNewlineIndex = textBeforeCaret.lastIndexOf("\n")
  return {
    row: textBeforeCaret.split("\n").length - 1,
    col: stringWidth(textBeforeCaret.slice(lastNewlineIndex + 1)),
  }
}

/**
 * Decides what the overlay should show for one tick. Returns null for "hide":
 * no suggestion, no proven editor, unusable geometry, or an empty suffix.
 * Every caller treats null the same way, and nothing here throws.
 */
export function planInlineRender(
  store: SuggestionStoreApi,
  editorSource: InlineEditorSource | null,
): InlineRenderPlan | null {
  if (!editorSource) return null
  const suggestionState = store.state()
  const candidate = suggestionState?.candidates[suggestionState.index]
  if (!suggestionState || !candidate) return null
  const editor = editorSource.currentEditor()
  if (!editor || editor.isDestroyed === true) return null
  if (typeof editor.plainText !== "string" || editor.plainText.length === 0) return null
  const textBeforeCaret = resolveCaretPrefixText(editor)
  if (textBeforeCaret === null) return null
  // Suffix TEXT and suffix POSITION come from the SAME source: the authoritative
  // caret prefix. `logicalCursor` is a different field from the `cursorOffset`
  // used to recover the text, so on a scroll/wrap boundary they can disagree —
  // the old code then painted the tail of one substring at the other's cell.
  const caretCell = caretCellFromPrefix(textBeforeCaret)
  const inlineSuffix = computeInlineSuffixFromPrefix(textBeforeCaret, candidate.text)
  if (!inlineSuffix) return null
  const geometry = resolveOverlayGeometry(editor, inlineSuffix, caretCell)
  if (!geometry) return null
  const fittedText = fitSuffixToWidth(geometry.suffix, geometry.availableCells)
  if (fittedText.length === 0) return null
  return { text: fittedText, x: geometry.x, y: geometry.y }
}

/** Mutable position properties an absolute box exposes at runtime. */
interface PositionedBoxRenderable extends OverlayTextRenderable {
  left: number
  top: number
  zIndex: number
  /** Absolute screen cell of this box's own origin. */
  readonly screenX: number
  readonly screenY: number
}

export function createInlineGhostOverlay(deps: InlineGhostOverlayDeps): InlineGhostOverlayApi {
  const themeText =
    (deps.theme as { text?: { muted?: string; base?: string } } | undefined)?.text ??
    ((deps.theme as { colors?: { textMuted?: string } } | undefined)?.colors)
  const mutedColor = themeText?.muted ?? "gray"

  // The host may keep several overlay trees alive across re-mounts; only the
  // fully captured, still-live ones are patched, the rest are pruned.
  interface MountedOverlay {
    suffixText: OverlayTextRenderable | null
    positionBox: PositionedBoxRenderable | null
    /**
     * Zero-size anchor pinned at left/top = (0,0) under the same slot
     * container as positionBox. Its own screen origin IS the container's
     * origin, read fresh on every patch so a re-layout (terminal resize,
     * textarea height change) never leaves the inset stale. Not derived
     * from positionBox because left/top feed back into screenX.
     */
    anchorBox: PositionedBoxRenderable | null
    /** Container's screen cell, re-read on every patch; null when unusable. */
    originColumn: number | null
    originRow: number | null
  }
  const mountedOverlays = new Set<MountedOverlay>()

  /**
   * Re-reads the slot container's screen origin from the self-owned zero-size
   * anchor and stores it on the overlay. Returns true when the origin is
   * usable this patch; otherwise originColumn/originRow are null and the
   * caller must hide the suffix (never fall back to deriving it from
   * positionBox — its left/top feed back into screenX).
   */
  function readContainerOrigin(overlay: MountedOverlay): boolean {
    const anchorBox = overlay.anchorBox
    if (!anchorBox) {
      overlay.originColumn = null
      overlay.originRow = null
      return false
    }
    try {
      const x = anchorBox.screenX
      const y = anchorBox.screenY
      if (typeof x !== "number" || !Number.isFinite(x)) {
        overlay.originColumn = null
        overlay.originRow = null
        return false
      }
      if (typeof y !== "number" || !Number.isFinite(y)) {
        overlay.originColumn = null
        overlay.originRow = null
        return false
      }
      overlay.originColumn = x
      overlay.originRow = y
      return true
    } catch {
      // A host that refuses these reads leaves the origin unknown → hidden.
      overlay.originColumn = null
      overlay.originRow = null
      return false
    }
  }

  function patchOverlay(overlay: MountedOverlay): void {
    const suffixText = overlay.suffixText
    const positionBox = overlay.positionBox
    const anchorBox = overlay.anchorBox
    if (!suffixText || !positionBox || !anchorBox) return
    if (suffixText.isDestroyed || positionBox.isDestroyed || anchorBox.isDestroyed) {
      mountedOverlays.delete(overlay)
      return
    }
    mountedOverlays.add(overlay)
    // Re-read the container origin on every patch; a re-layout moves the
    // container and the cached value would permanently misplace the inset.
    const hasContainerOrigin = readContainerOrigin(overlay)
    let plan: InlineRenderPlan | null = null
    try {
      plan = planInlineRender(deps.store, deps.editorSource)
    } catch {
      // Geometry reads touch host objects; a broken host must not take the
      // row above the composer down with it.
      plan = null
    }
    if (plan && hasContainerOrigin && overlay.originColumn !== null && overlay.originRow !== null) {
      suffixText.content = plan.text
      // Plan coordinates are absolute screen cells; left/top are inset from
      // the slot container, so the container origin is removed here.
      positionBox.left = plan.x - overlay.originColumn
      positionBox.top = plan.y - overlay.originRow
      suffixText.visible = true
    } else {
      suffixText.visible = false
    }
  }

  return {
    renderOverlay(): unknown {
      const mountedOverlay: MountedOverlay = {
        suffixText: null,
        positionBox: null,
        anchorBox: null,
        originColumn: null,
        originRow: null,
      }
      mountedOverlays.add(mountedOverlay)
      // Single-root, IN-FLOW zero-size anchor (proven: JosXa/opencode-snippets).
      // A slot render may return one JSX element; the anchor itself occupies no
      // cells in the composer region, and its screen origin IS that region's
      // origin. The suffix lives in a NESTED absolutely-positioned child, so its
      // left/top are inset relative to the anchor — no screen-cell arithmetic
      // against a foreign container, and no dependency on the app slot's flow
      // position (the old bug: two absolute siblings anchored to the wrong
      // container and landed off-screen).
      return (
        <box
          width={0}
          height={0}
          focusable={false}
          ref={(anchorRenderable: unknown) => {
            mountedOverlay.anchorBox = (anchorRenderable as PositionedBoxRenderable | null) ?? null
            patchOverlay(mountedOverlay)
          }}
        >
          <box
            position="absolute"
            left={0}
            top={0}
            zIndex={1000}
            ref={(positionRenderable: unknown) => {
              mountedOverlay.positionBox = (positionRenderable as PositionedBoxRenderable | null) ?? null
              patchOverlay(mountedOverlay)
            }}
          >
            <text
              fg={mutedColor}
              ref={(textRenderable: unknown) => {
                mountedOverlay.suffixText = (textRenderable as OverlayTextRenderable | null) ?? null
                patchOverlay(mountedOverlay)
              }}
            />
          </box>
        </box>
      )
    },
    refresh(): void {
      for (const overlay of [...mountedOverlays]) {
        if (overlay.suffixText?.isDestroyed === true) {
          // A re-mounted slot leaves a destroyed tree behind; drop it here so
          // the set cannot grow without bound across host re-renders.
          mountedOverlays.delete(overlay)
          continue
        }
        patchOverlay(overlay)
      }
    },
  }
}
