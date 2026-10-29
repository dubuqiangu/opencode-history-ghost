/** @jsxImportSource @opentui/solid */
// Renders the inline ghost suffix over the composer (方案 B: absolute 覆盖层).
//
// This file owns exactly one line of one renderable: a static `text` node
// pinned with position:absolute on the renderer root. refresh() recomputes the
// caret cell and the suffix text and writes them onto that node; it never
// creates, destroys or re-mounts anything, so the host's reconciler never sees
// us churn and layout cost stays at one node.
//
// Why the renderer root: the textarea lives under the session slot tree and we
// cannot add a child to it. screenX/screenY are absolute screen cells, so
// pinning our node to the root (origin = screen cell 0,0) needs no
// ancestor-local arithmetic.
//
// Degradation contract: planInlineRender() returns null whenever the editor
// instance, its geometry or the store state is unusable. The overlay then sets
// visible=false and does nothing else — no throw, no warning spam, and the row
// above the composer keeps showing the suggestion.

import type { EditBufferLike } from "./editor-bridge"
import type { SuggestionStoreApi } from "./suggestion-store"
import { clampToCellBudget } from "./string-width"
import { computeInlineSuffix, resolveCaretCell, resolveOverlayGeometry } from "./ghost-overlay"

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
  const caretCell = resolveCaretCell(editor)
  if (!caretCell) return null
  const inlineSuffix = computeInlineSuffix(editor.plainText, editor.cursorOffset, candidate.text)
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
  /** Most recently mounted overlay for this slot; dropped on the next remount. */
  let lastOverlay: MountedOverlay | null = null

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
      if (lastOverlay) mountedOverlays.delete(lastOverlay)
      const mountedOverlay: MountedOverlay = {
        suffixText: null,
        positionBox: null,
        anchorBox: null,
        originColumn: null,
        originRow: null,
      }
      lastOverlay = mountedOverlay
      mountedOverlays.add(mountedOverlay)
      return [
        // Zero-size anchor: its screen origin IS the slot container's origin.
        <box
          position="absolute"
          left={0}
          top={0}
          width={0}
          height={0}
          zIndex={1}
          ref={(anchorRenderable: unknown) => {
            mountedOverlay.anchorBox = (anchorRenderable as PositionedBoxRenderable | null) ?? null
            patchOverlay(mountedOverlay)
          }}
        />,
        <box
          position="absolute"
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
        </box>,
      ]
    },
    refresh(): void {
      for (const overlay of mountedOverlays) patchOverlay(overlay)
    },
  }
}
