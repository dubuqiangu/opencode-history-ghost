/** @jsxImportSource @opentui/solid */
// Imperative ghost suggestion line for opencode-history-ghost (T7, DESIGN §3.5).
//
// REACTIVITY DECISION (defect-1 fix, same evidence chain as suggestion-store):
// plugin-side solid signals/memos land on the parasitic module graph under
// the current packaging, so their updates never reach the host slot machinery
// (usage-meter pitfalls #13/#16). This component therefore uses NO solid
// primitive at all:
//   - renderRow() builds a fully STATIC JSX row per host slot render (static
//     trees mount on every packaging configuration observed so far);
//   - `ref` callbacks capture the renderable instances (the jsx-runtime fires
//     refs once at creation, immediately, regardless of graph health);
//   - refresh() mutates the captured renderables' `content` / `visible`
//     properties directly (TextRenderable.content setter, Renderable.visible
//     setter) — the caller then schedules renderer.requestRender(), and the
//     screen repaints from whatever the tree holds.
//
// Layout: one row above the composer — candidate text split around the typed
// input (match region in normal color, everything else dim), a "(+N 行)" note
// for multi-line candidates, and the accept/cycle/dismiss hint on the right.
// Colors come from context.theme: text.muted for dim, text.base for normal,
// fixed gray fallback.

import type { HistoryGhostSettings, SuggestionState, SuggestionStoreApi } from "./suggestion-store"
import type { HistoryEntry } from "./history-source"
import { createInlineGhostOverlay, type InlineEditorSource } from "./ghost-overlay-render"

/** Display cap per line, in code units, before the ellipsis (DESIGN §3.5). */
const MAX_DISPLAY_CODE_UNITS = 100

export interface GhostLineDeps {
  readonly store: SuggestionStoreApi
  readonly settings: HistoryGhostSettings
  /** ResolvedTheme from the plugin context; accessed defensively. */
  readonly theme: unknown
  /**
   * Optional access to the proven composer textarea. When present the
   * suggestion is also drawn inside the input (grey suffix after the caret);
   * when absent the row above the composer alone carries it.
   */
  readonly editorSource?: InlineEditorSource | null
}

/** Structural slice of TextRenderable this controller patches imperatively. */
interface MutableTextRenderable {
  content: string
  readonly isDestroyed: boolean
}

/** Structural slice of Renderable used to collapse the whole row. */
interface VisibilityRenderable {
  visible: boolean
  readonly isDestroyed: boolean
}

type GhostTextFieldName = "leadingDim" | "typedMatch" | "trailingDim" | "multilineNote" | "hint"

interface GhostLineSegments {
  /** Candidate text before the matched input region (dim; substring bucket only). */
  readonly leadingDim: string
  /** The region matching the typed input (normal color). */
  readonly typedMatch: string
  /** Everything after the typed region, ellipsis-truncated (dim). */
  readonly trailingDim: string
  /** " (+N 行)" note for multi-line candidates; empty for single-line ones. */
  readonly multilineNote: string
  /** Right-side hint: accept key, (current/total), cycle and dismiss keys. */
  readonly hint: string
}

function acceptKeyLabel(acceptKey: string): string {
  if (acceptKey === "tab") return "Tab"
  if (acceptKey === "right") return "→"
  return acceptKey
}

function computeSegments(
  settings: HistoryGhostSettings,
  suggestionState: SuggestionState,
  candidate: HistoryEntry,
): GhostLineSegments {
  const typedInput = suggestionState.input
  const inputLower = typedInput.toLowerCase()

  // Multi-line candidates show their first line only; accepting still
  // replaces the whole text (tleclaire approach, DESIGN §3.5).
  const [firstLine, ...restLines] = candidate.text.split("\n")
  const extraLineCount = restLines.length
  const multilineNote = extraLineCount > 0 ? ` (+${extraLineCount} 行)` : ""

  const displayFirstLine =
    firstLine.length > MAX_DISPLAY_CODE_UNITS
      ? `${firstLine.slice(0, MAX_DISPLAY_CODE_UNITS)}…`
      : firstLine

  // Split the displayed line around the typed input's first occurrence in
  // the candidate: prefix matches start at 0, substring matches anywhere;
  // fuzzy candidates without a contiguous match render fully dim.
  let leadingDim = ""
  let typedMatch = ""
  let trailingDim = displayFirstLine
  const matchStart = candidate.lower.indexOf(inputLower)
  if (typedInput.length > 0 && matchStart >= 0) {
    leadingDim = displayFirstLine.slice(0, matchStart)
    typedMatch = displayFirstLine.slice(matchStart, matchStart + typedInput.length)
    trailingDim = displayFirstLine.slice(matchStart + typedInput.length)
  }

  const hint = `${acceptKeyLabel(settings.acceptKey)} 接受 · (${suggestionState.index + 1}/${suggestionState.candidates.length}) ctrl+↑↓ 切换 · Esc 取消`

  return { leadingDim, typedMatch, trailingDim, multilineNote, hint }
}

export interface GhostLineController {
  /** Static row for the composer.top slot render; refs self-patch on capture. */
  renderRow(): unknown
  /** Re-patches the captured renderables from the store's current state. */
  refresh(): void
  /**
   * Static inline overlay for the `app` slot: the untyped suffix drawn over
   * the composer in muted grey. Returns null when no editor source was
   * injected, so callers can mount it unconditionally.
   */
  renderInlineOverlay(): unknown
}

export function createGhostLine(deps: GhostLineDeps): GhostLineController {
  const themeText = (deps.theme as { text?: { muted?: string; base?: string } } | undefined)?.text
  const dimColor = themeText?.muted ?? "gray"
  const baseColor = themeText?.base

  // Each call produces a separate mount. The host can retain more than one
  // row on the same renderer, so keep all fully captured, live rows in sync.
  interface MountedRow {
    rowBox: VisibilityRenderable | null
    textRenderables: Record<GhostTextFieldName, MutableTextRenderable | null>
  }
  const mountedRows = new Set<MountedRow>()

  // Inline overlay is opt-in through the injected editor source; it degrades to
  // a no-op controller when the assembly cannot hand us a trustworthy textarea.
  const inlineOverlay = deps.editorSource
    ? createInlineGhostOverlay({ store: deps.store, editorSource: deps.editorSource, theme: deps.theme })
    : null

  /** Patches only complete, live rows; discarded rows are pruned on refresh. */
  function patchFromState(mount: MountedRow): void {
    const textRenderables = Object.values(mount.textRenderables)
    if (!mount.rowBox || textRenderables.some((renderable) => !renderable)) return
    if (mount.rowBox.isDestroyed || textRenderables.some((renderable) => renderable!.isDestroyed)) {
      mountedRows.delete(mount)
      return
    }
    mountedRows.add(mount)
    const suggestionState = deps.store.state()
    const candidate = suggestionState?.candidates[suggestionState.index]
    if (!suggestionState || !candidate) {
      // No suggestion: collapse the whole row (invisible renderables are
      // skipped by layout).
      mount.rowBox.visible = false
      return
    }
    mount.rowBox.visible = true
    const segments = computeSegments(deps.settings, suggestionState, candidate)
    for (const fieldName of Object.keys(mount.textRenderables) as GhostTextFieldName[]) {
      mount.textRenderables[fieldName]!.content = segments[fieldName]
    }
  }

  function retainTextRenderable(mount: MountedRow, fieldName: GhostTextFieldName, renderable: unknown): void {
    mount.textRenderables[fieldName] = (renderable as MutableTextRenderable | null) ?? null
    // Ref callbacks may arrive while a row is still being built. Only patch
    // after all nodes have arrived, including the parent box.
    patchFromState(mount)
  }

  return {
    renderRow(): unknown {
      const mount: MountedRow = {
        rowBox: null,
        textRenderables: {
          leadingDim: null,
          typedMatch: null,
          trailingDim: null,
          multilineNote: null,
          hint: null,
        },
      }
      return (
        <box
          flexDirection="row"
          ref={(rowRenderable: unknown) => {
            mount.rowBox = (rowRenderable as VisibilityRenderable | null) ?? null
            patchFromState(mount)
          }}
        >
          <text
            fg={dimColor}
            ref={(textRenderable: unknown) => retainTextRenderable(mount, "leadingDim", textRenderable)}
          />
          <text
            fg={baseColor}
            ref={(textRenderable: unknown) => retainTextRenderable(mount, "typedMatch", textRenderable)}
          />
          <text
            fg={dimColor}
            ref={(textRenderable: unknown) => retainTextRenderable(mount, "trailingDim", textRenderable)}
          />
          <text
            fg={dimColor}
            ref={(textRenderable: unknown) => retainTextRenderable(mount, "multilineNote", textRenderable)}
          />
          <box flexGrow={1} flexShrink={0} />
          <text
            fg={dimColor}
            ref={(textRenderable: unknown) => retainTextRenderable(mount, "hint", textRenderable)}
          />
        </box>
      )
    },
    refresh(): void {
      for (const mount of mountedRows) patchFromState(mount)
      inlineOverlay?.refresh()
    },
    renderInlineOverlay(): unknown {
      return inlineOverlay ? inlineOverlay.renderOverlay() : null
    },
  }
}
