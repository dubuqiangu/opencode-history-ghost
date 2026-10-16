// Keymap layer for opencode-history-ghost (T8, DESIGN §3.6).
//
// MUST be registered from inside a slot render — calling it directly from
// setup() throws "Keymap.Provider is missing" on the host (verified with the
// opencode-autocontinue plugin, which registers its layer from the first
// `app` slot render for exactly this reason).
//
// The layer is globally scoped but enabled only while all three hold:
//   - the master switch is on,
//   - a suggestion is currently visible,
//   - the host's own completion popup is inactive (its input mode is
//     "autocomplete" while open) — so Tab is always yielded to the host's
//     @// completion, never stolen (DESIGN §2 "Tab mode 隔离").
//
// Signatures verified against @opencode/plugin dist/tui/context.d.ts:339-416
// (KeymapCommand / KeymapLayer / Keymap). keymap.layer() returns void per
// its type — the host removes the layer when the creating reactive scope
// disposes — but a disposable return value is still captured defensively,
// mirroring the working autocontinue pattern.
//
// RUN-TIME CONSISTENCY GUARD (defect-2 fix): a visible suggestion was
// produced from the composer's text, so every store-mutating command first
// re-verifies that the focused editor still holds exactly that (trimmed)
// input. A dialog input focused within the editor bridge's <= 1.5s poll
// race window — or any other focus anomaly — yields the key back to the
// host instead of firing on the wrong editor.

import type { EditorBridge } from "./editor-bridge"
import type { HistoryGhostSettings, SuggestionStoreApi } from "./suggestion-store"

export interface KeymapDeps {
  readonly bridge: EditorBridge
  readonly store: SuggestionStoreApi
  readonly settings: HistoryGhostSettings
  /** Master-switch callback for the palette command. */
  readonly onToggle: () => void
}

/** Structural subset of the plugin-context Keymap surface. */
interface KeymapLike {
  layer(factory: () => unknown): unknown
  readonly mode?: { current(): string }
}

const LOG_PREFIX = "[opencode-history-ghost]"

/** Reads the current input mode without ever throwing; "" when unknown. */
function safeInputMode(keymap: KeymapLike): string {
  try {
    return keymap.mode?.current() ?? ""
  } catch {
    return ""
  }
}

/**
 * True while the focused editor's text still equals the (trimmed) input the
 * visible suggestion was produced from — see the header's run-time
 * consistency guard.
 */
function suggestionMatchesFocusedEditor(deps: KeymapDeps): boolean {
  const suggestionState = deps.store.state()
  if (!suggestionState) return false
  const focusedEditorText = deps.bridge.inputText()
  if (focusedEditorText === null) return false
  return focusedEditorText.trim() === suggestionState.input
}

/**
 * Registers the history-ghost keymap layer. Returns a cleanup function that
 * unregisters it best-effort (a no-op when the host owns layer lifetime).
 */
export function registerKeymap(context: unknown, deps: KeymapDeps): () => void {
  const keymap = (context as { keymap?: KeymapLike } | undefined)?.keymap
  if (!keymap || typeof keymap.layer !== "function") {
    console.warn(`${LOG_PREFIX} keymap API unavailable; history-ghost shortcuts are disabled`)
    return () => {}
  }

  const requestRender = (): void => {
    try {
      ;(context as { renderer?: { requestRender?: () => void } } | undefined)?.renderer?.requestRender?.()
    } catch {
      // Repaint scheduling is best-effort.
    }
  }

  let layerDispose: (() => void) | undefined
  try {
    const layerResult = keymap.layer(() => ({
      mode: "global",
      // Only dispatch while the composer textarea itself has focus.
      target: () => deps.bridge.current(),
      enabled: () =>
        deps.settings.enabled === true &&
        deps.store.hasSuggestion() &&
        safeInputMode(keymap) !== "autocomplete",
      commands: [
        {
          id: "history-ghost.accept",
          title: "History Ghost: 接受建议",
          bind: deps.settings.acceptKey,
          run: () => {
            const candidate = deps.store.current()
            if (!candidate) return false
            // Focus race guard (see header): a dialog input focused within
            // the bridge's poll window must never be rewritten by Tab.
            if (!suggestionMatchesFocusedEditor(deps)) return false
            // Only ever accept while the caret sits at the end of the input
            // (fish/pi convention, DESIGN §4) — a caret moved into the middle
            // must not have Tab steal the whole buffer.
            if (!deps.bridge.cursorAtEnd()) return false
            // Consumed on success (no return value); yielded back to the host
            // only when the editor write failed so Tab still does something.
            if (!deps.bridge.acceptFullText(candidate.text)) return false
            deps.store.clear()
            requestRender()
          },
        },
        {
          id: "history-ghost.cycle-next",
          title: "History Ghost: 下一条建议",
          bind: "ctrl+down",
          run: () => {
            if (!suggestionMatchesFocusedEditor(deps)) return false
            deps.store.cycle(1)
            requestRender()
          },
        },
        {
          id: "history-ghost.cycle-prev",
          title: "History Ghost: 上一条建议",
          bind: "ctrl+up",
          run: () => {
            if (!suggestionMatchesFocusedEditor(deps)) return false
            deps.store.cycle(-1)
            requestRender()
          },
        },
        {
          id: "history-ghost.dismiss",
          title: "History Ghost: 取消建议",
          bind: "escape",
          run: () => {
            // Focus race guard: a dialog's first Esc must close the dialog,
            // not dismiss a composer suggestion.
            if (!suggestionMatchesFocusedEditor(deps)) return false
            deps.store.dismiss()
            requestRender()
          },
        },
        {
          id: "history-ghost.toggle",
          title: "History Ghost: 开关历史建议",
          palette: true,
          run: () => {
            deps.onToggle()
          },
        },
      ],
    }))
    if (typeof (layerResult as { dispose?: unknown })?.dispose === "function") {
      layerDispose = (layerResult as { dispose: () => void }).dispose
    } else if (typeof layerResult === "function") {
      layerDispose = layerResult as () => void
    }
  } catch (error) {
    layerDispose = undefined
    console.warn(`${LOG_PREFIX} keymap layer registration failed:`, error)
  }

  return () => {
    try {
      layerDispose?.()
    } catch (error) {
      console.warn(`${LOG_PREFIX} keymap layer unregistration failed:`, error)
    }
  }
}
