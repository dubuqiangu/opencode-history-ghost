/** @jsxImportSource @opentui/solid */
// Assembly entry for opencode-history-ghost (T9, DESIGN §3.7).
//
// setup() only wires modules together — no business logic lives here:
//   durable settings → history source → editor bridge → suggestion store →
//   ghost line controller → input/caret wiring → two slots → 3s history
//   refresh interval → idempotent cleanup that clears every timer, hook,
//   subscription, and slot.
//
// Keymap placement (defect-2 fix): keymap.layer() returns void and its
// lifetime binds to the reactive scope that called it — registering from a
// session.composer.top slot render ties the layer to that session's mount
// scope, so leaving the session destroys the layer and the once-guard blocks
// re-registration on return (Tab/Esc/cycle/toggle all die). The proven fix
// (opencode-autocontinue, real-machine verified): claim a separate global
// `append: "app"` slot whose render returns null and register the layer
// there — the app slot lives for the whole TUI session.
//
// UI pipeline (defect-1 fix): the store carries plain-object state; every
// committed change fires the onStateChange listener below, which patches the
// ghost line imperatively and schedules renderer.requestRender(). No solid
// primitive is imported anywhere in this plugin — see ghost-line.tsx for the
// module-graph evidence.

import { Plugin } from "@opencode/plugin/tui"
import { createHistorySource } from "./history-source"
import { createEditorBridge } from "./editor-bridge"
import { createSuggestionStore, type HistoryGhostSettings } from "./suggestion-store"
import { createGhostLine } from "./ghost-line"
import { registerKeymap } from "./keymap"

/** History-source refresh cadence (jsonl mtime poll, DESIGN §2). */
const HISTORY_REFRESH_INTERVAL_MS = 3000

/** Durable-settings defaults (DESIGN §3.8); fresh object per call. */
function defaultSettings(): HistoryGhostSettings {
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

export default Plugin.define({
  id: "history-ghost",
  setup(context: any) {
    // ---- Durable settings (DESIGN §3.8): survives restarts, hot reloads,
    // and live-syncs across running TUI instances. Storage-miss fallback
    // (defect-6 fix): a host without the storage API must not crash setup —
    // fall back to a plain in-memory object the toggle mutates directly.
    let resolvedSettings: HistoryGhostSettings | undefined
    let updateSettings: ((mutation: (draft: HistoryGhostSettings) => void) => Promise<void>) | undefined
    try {
      const settingsPair = context.storage?.store?.("history-ghost-settings", {
        initial: defaultSettings(),
      })
      if (settingsPair && settingsPair[0]) {
        resolvedSettings = settingsPair[0]
        updateSettings = settingsPair[1]
      }
    } catch (error) {
      console.warn("[opencode-history-ghost] settings storage unavailable; using in-memory defaults:", error)
    }
    const settings: HistoryGhostSettings = resolvedSettings ?? defaultSettings()

    // ---- Module assembly.
    const historySource = createHistorySource({
      maxEntries: settings.maxEntries,
      maxTextLength: settings.maxTextLength,
    })
    const editorBridge = createEditorBridge(context)
    const suggestionStore = createSuggestionStore(() => historySource.entries(), settings)
    const ghostLine = createGhostLine({ store: suggestionStore, settings, theme: context.theme })

    const requestRender = (): void => {
      try {
        context?.renderer?.requestRender?.()
      } catch {
        // Repaint scheduling is best-effort.
      }
    }

    // ---- UI pipeline: every committed store change patches the ghost line
    // and asks the renderer for a repaint. This one listener covers every
    // mutation path (typing, cycle, dismiss, accept, toggle).
    const stopStateListening = suggestionStore.onStateChange(() => {
      ghostLine.refresh()
      requestRender()
    })

    // ---- Input wiring: re-evaluate the suggestion on every keystroke.
    // Ghost text only appears while the caret sits at the end of the input
    // (fish/pi convention, DESIGN §4); anywhere else the line collapses.
    const stopInputListening = editorBridge.onInput((text: string) => {
      try {
        if (!editorBridge.cursorAtEnd()) {
          suggestionStore.clear()
        } else {
          suggestionStore.evaluate(text)
        }
      } catch (error) {
        console.warn("[opencode-history-ghost] input handling failed:", error)
      }
    })
    // Typing alone cannot see the caret LEAVING the end (pure cursor moves
    // fire onCursorChange, not onContentChange) — collapse on those.
    const stopCaretListening = editorBridge.onCaretMove((caretAtEnd: boolean) => {
      if (!caretAtEnd) suggestionStore.clear()
    })
    // Focus landing on a foreign editor surface (dialog input, sidebar
    // search) while the known composer still lives: the bridge refuses to
    // follow, so no NEW suggestion can appear from that typing — this only
    // collapses whatever was already visible so the ghost line cannot
    // linger above the composer during dialogs (defect-2 fix).
    const stopForeignFocusListening = editorBridge.onForeignEditorFocus(() => {
      suggestionStore.clear()
    })
    // Keep the composer hooks mounted across host-side textarea rebuilds
    // and same-instance listener-slot overwrites.
    editorBridge.watch()

    // ---- Master-switch callback (palette command "History Ghost: 开关历史建议").
    const onToggle = (): void => {
      const nextEnabled = !settings.enabled
      try {
        if (updateSettings) {
          void updateSettings((draft: HistoryGhostSettings) => {
            draft.enabled = nextEnabled
          })
        } else {
          // In-memory fallback: mutate the plain object directly.
          settings.enabled = nextEnabled
        }
      } catch (error) {
        // The durable write failed — flip the live view anyway so the UI
        // still responds this session.
        try {
          settings.enabled = nextEnabled
        } catch {
          // A failed direct mutation means the settings object is frozen;
          // nothing more to do but report.
        }
        console.warn("[opencode-history-ghost] settings toggle failed:", error)
      }
      suggestionStore.clear()
      requestRender()
      try {
        context?.ui?.toast?.show?.({
          title: "History Ghost",
          message: nextEnabled ? "历史建议已开启" : "历史建议已关闭",
          variant: nextEnabled ? "success" : "info",
        })
      } catch {
        // Toast surface unavailable — the setting still flipped.
      }
    }

    // ---- Global keymap slot (defect-2 fix): the app slot lives for the
    // whole TUI session, so the keymap layer registered from its render
    // survives session switches. Registration must happen inside a slot
    // render (a direct setup() call throws "Keymap.Provider is missing").
    let keymapCleanup: (() => void) | undefined
    let stopAppSlot: (() => void) | undefined
    try {
      const appSlotResult = context.ui?.slot?.({
        append: "app",
        render: () => {
          if (keymapCleanup === undefined) {
            keymapCleanup = registerKeymap(context, {
              bridge: editorBridge,
              store: suggestionStore,
              settings,
              onToggle,
            })
          }
          return null
        },
      })
      if (typeof appSlotResult?.dispose === "function") stopAppSlot = appSlotResult.dispose
      else if (typeof appSlotResult === "function") stopAppSlot = appSlotResult
    } catch (error) {
      console.warn("[opencode-history-ghost] app slot registration failed:", error)
    }

    // ---- Composer-top slot: the ghost line only. Pure rendering, no
    // keymap registration here (see the app slot above).
    let stopComposerSlot: (() => void) | undefined
    try {
      const slotResult = context.ui?.slot?.({
        append: "session.composer.top",
        render: () => ghostLine.renderRow(),
      })
      if (typeof slotResult?.dispose === "function") stopComposerSlot = slotResult.dispose
      else if (typeof slotResult === "function") stopComposerSlot = slotResult
    } catch (error) {
      console.warn("[opencode-history-ghost] composer slot registration failed:", error)
    }

    // ---- History refresh: jsonl mtime poll covers prompts that were just
    // submitted but are not in the DB yet (DESIGN §2).
    const historyRefreshTimer = setInterval(() => {
      try {
        historySource.refresh()
      } catch (error) {
        console.warn("[opencode-history-ghost] history refresh failed:", error)
      }
    }, HISTORY_REFRESH_INTERVAL_MS)

    // ---- Cleanup: every registered resource is released exactly once,
    // whether the host calls the setup() return value or not.
    let disposed = false
    function disposeAll(): void {
      if (disposed) return
      disposed = true
      clearInterval(historyRefreshTimer)
      stopStateListening()
      stopInputListening()
      stopCaretListening()
      stopForeignFocusListening()
      editorBridge.dispose()
      keymapCleanup?.()
      stopAppSlot?.()
      stopComposerSlot?.()
    }

    return disposeAll
  },
})
