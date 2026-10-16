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

/** Display cap per line, in code units, before the ellipsis (DESIGN §3.5). */
const MAX_DISPLAY_CODE_UNITS = 100

export interface GhostLineDeps {
  readonly store: SuggestionStoreApi
  readonly settings: HistoryGhostSettings
  /** ResolvedTheme from the plugin context; accessed defensively. */
  readonly theme: unknown
}

/** Structural slice of TextRenderable this controller patches imperatively. */
interface MutableTextRenderable {
  content: string
}

/** Structural slice of Renderable used to collapse the whole row. */
interface VisibilityRenderable {
  visible: boolean
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
}

export function createGhostLine(deps: GhostLineDeps): GhostLineController {
  const themeText = (deps.theme as { text?: { muted?: string; base?: string } } | undefined)?.text
  const dimColor = themeText?.muted ?? "gray"
  const baseColor = themeText?.base

  let rowBox: VisibilityRenderable | null = null
  const textRenderables: Record<GhostTextFieldName, MutableTextRenderable | null> = {
    leadingDim: null,
    typedMatch: null,
    trailingDim: null,
    multilineNote: null,
    hint: null,
  }

  /** Patches every captured renderable from the store's current state. */
  function patchFromState(): void {
    if (!rowBox) return
    const suggestionState = deps.store.state()
    const candidate = suggestionState?.candidates[suggestionState.index]
    if (!suggestionState || !candidate) {
      // No suggestion: collapse the whole row (invisible renderables are
      // skipped by layout).
      rowBox.visible = false
      return
    }
    rowBox.visible = true
    const segments = computeSegments(deps.settings, suggestionState, candidate)
    for (const fieldName of Object.keys(textRenderables) as GhostTextFieldName[]) {
      const textRenderable = textRenderables[fieldName]
      if (textRenderable) textRenderable.content = segments[fieldName]
    }
  }

  function retainTextRenderable(fieldName: GhostTextFieldName, renderable: unknown): void {
    textRenderables[fieldName] = renderable as MutableTextRenderable
    // Mount-time state displays immediately: refs fire during the slot
    // render, so patch right after every capture.
    patchFromState()
  }

  return {
    renderRow(): unknown {
      return (
        <box
          flexDirection="row"
          ref={(rowRenderable: unknown) => {
            rowBox = rowRenderable as VisibilityRenderable
            patchFromState()
          }}
        >
          <text
            fg={dimColor}
            ref={(textRenderable: unknown) => retainTextRenderable("leadingDim", textRenderable)}
          />
          <text
            fg={baseColor}
            ref={(textRenderable: unknown) => retainTextRenderable("typedMatch", textRenderable)}
          />
          <text
            fg={dimColor}
            ref={(textRenderable: unknown) => retainTextRenderable("trailingDim", textRenderable)}
          />
          <text
            fg={dimColor}
            ref={(textRenderable: unknown) => retainTextRenderable("multilineNote", textRenderable)}
          />
          <box flexGrow={1} />
          <text
            fg={dimColor}
            ref={(textRenderable: unknown) => retainTextRenderable("hint", textRenderable)}
          />
        </box>
      )
    },
    refresh(): void {
      patchFromState()
    },
  }
}
