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

import { createHistorySource } from "./history-source"
import { createEditorBridge } from "./editor-bridge"
import { createComposerIdentity } from "./composer-identity"
import { createSuggestionStore, type HistoryGhostSettings } from "./suggestion-store"
import { createGhostLine } from "./ghost-line"
import { registerKeymap } from "./keymap"

import { recordFailure } from "./probe-log"

/** History-source refresh cadence (jsonl mtime poll, DESIGN §2). */
const HISTORY_REFRESH_INTERVAL_MS = 3000

/**
 * Hot-reload registry (tleclaire/opencode-autocomplete approach, DESIGN §3.7).
 *
 * The host may re-run setup() on the same process (plugin reload, live-sync,
 * config touch) without first tearing down the previous instance. Timers,
 * listener wrappers, slots and keymap layers from the old instance would
 * otherwise stack with the new ones, or silently crash the reload. We keep ONE
 * disposer per plugin id on globalThis and run it before the new instance
 * registers, so at most one instance is ever live.
 */
const RELOAD_REGISTRY_KEY = "opencode-history-ghost.activeInstance"

function disposeRegisteredInstance(): void {
  const globalState = globalThis as Record<string, unknown>
  const previousDispose = globalState[RELOAD_REGISTRY_KEY]
  if (typeof previousDispose === "function") {
    try {
      ;(previousDispose as () => void)()
    } catch (error) {
      console.warn("[opencode-history-ghost] failed to dispose previous instance on reload:", error)
    }
  }
}

function registerActiveInstance(dispose: () => void): void {
  const globalState = globalThis as Record<string, unknown>
  globalState[RELOAD_REGISTRY_KEY] = dispose
}

/** Durable-settings defaults (DESIGN §3.8); fresh object per call. */
function defaultSettings(): HistoryGhostSettings {
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

/**
 * Vendored plugin definition helper (opencode-db-insight pattern).
 *
 * The host loads a plugin entry with a plain dynamic import and validates
 * the default export's shape ({ id, setup }) directly — the upstream
 * `Plugin.define()` is an identity function, so we ship our own instead of
 * importing @opencode/plugin at runtime. The opencode TUI process does not
 * resolve `@opencode/plugin` for cache-installed GitHub plugins (the install
 * lives outside the opencode source tree where the host's copy is bundled),
 * so a static `import { Plugin } from "@opencode/plugin/tui"` makes the whole
 * `./tui` entry fail to load in the TUI with "Cannot find package
 * '@opencode/plugin'". Keeping @opencode/plugin out of the runtime import
 * graph lets the installed package resolve only the exactly pinned
 * @opentui/* peer tree.
 */
export interface GhostPluginDefinition {
  readonly id: string
  readonly setup: (context: any) => Promise<(() => void) | void> | (() => void) | void
}

/** Identity helper preserving the Plugin.define({...}) call shape. */
export function defineGhostPlugin(definition: GhostPluginDefinition): GhostPluginDefinition {
  return definition
}

export default defineGhostPlugin({
  id: "history-ghost",
  setup(context: any) {
    // The host runs this plugin definition once per process role:
    //   - role=server  (the serve/daemon process): NO `ui` surface at all.
    //   - role=cli     (the TUI client process):     `ui.slot`, `ui.dialog`,
    //                                                 `ui.toast`, `renderer`,
    //                                                 `theme`, and top-level
    //                                                 `keymap.layer`.
    // Registering UI from the server process is meaningless: every
    // `context.ui?.slot?.(...)` there evaluates to `undefined`, silently
    // skipping all slots and leaving the keymap layer unreachable (its render
    // never runs). Bail out explicitly instead of relying on optional chaining.
    if (typeof context?.ui?.slot !== "function") return

    // Hot-reload guard: tear down any prior live instance before this one
    // registers (tleclaire/opencode-autocomplete approach). Only the TUI
    // client reaches this point; the server role returned above, so we never
    // dispose the TUI instance from the server process.
    disposeRegisteredInstance()

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
      recordFailure("settings.store", error)
      console.warn("[opencode-history-ghost] settings storage unavailable; using in-memory defaults:", error)
    }
    const settings: HistoryGhostSettings = resolvedSettings ?? defaultSettings()

    // ---- Module assembly.
    const historySource = createHistorySource({
      maxEntries: settings.maxEntries,
      maxTextLength: settings.maxTextLength,
    })
    const composerIdentity = createComposerIdentity(context)
    const editorBridge = createEditorBridge(context, composerIdentity)
    const suggestionStore = createSuggestionStore(() => historySource.entries(), settings)
    const ghostLine = createGhostLine({
      store: suggestionStore,
      settings,
      theme: context.theme,
      // The in-box inline overlay is deliberately NOT injected: the real-machine
      // probe proved this opencode host ignores `position:absolute` left/top
      // writes on a nested box (writing `top=1` left the node at the anchor row,
      // never moving it onto the textarea). So the row-above ghost line is the
      // sole suggestion surface. `editorBridge` is still created below for
      // caret-prefix matching + accept.
    })
    let observedHistoryEntries = historySource.entries()
    let disposed = false

    const requestRender = (): void => {
      try {
        context?.renderer?.requestRender?.()
      } catch {
        // Repaint scheduling is best-effort.
      }
    }

    // ---- UI pipeline: every committed store change patches the ghost line
    // and asks the renderer for a repaint. This one listener covers every
    // mutation path (typing, caret moves, cycle, dismiss, accept, toggle).
    const stopStateListening = suggestionStore.onStateChange(() => {
      ghostLine.refresh()
      requestRender()
    })

    // ---- Input wiring: match only the prefix before the caret. The bridge
    // obtains native display-cell ranges, not JS string offset slices.
    const evaluateCaretPrefix = (): void => {
      try {
        const prefix = editorBridge.caretPrefix()
        if (prefix === null) suggestionStore.clear()
        else suggestionStore.evaluate(prefix)
      } catch (error) {
        recordFailure("input.evaluate", error)
        console.warn("[opencode-history-ghost] input handling failed:", error)
      }
    }
    const reassessChangedHistory = (): void => {
      if (disposed) return
      const latestEntries = historySource.entries()
      if (latestEntries === observedHistoryEntries) return
      observedHistoryEntries = latestEntries
      try {
        const prefix = editorBridge.caretPrefix()
        if (prefix === null) suggestionStore.clear()
        else suggestionStore.reassess(prefix)
      } catch (error) {
        recordFailure("input.reassess", error)
        console.warn("[opencode-history-ghost] history re-assessment failed:", error)
      }
    }
    // DB loading resolves without an input event. A disposed instance must not
    // touch the bridge/store when the asynchronous load finally settles.
    void historySource.whenReady?.().then(reassessChangedHistory, (error) => {
      if (!disposed) console.warn("[opencode-history-ghost] history readiness failed:", error)
    })
    const stopInputListening = editorBridge.onInput(evaluateCaretPrefix)
    // Cursor-only movements can change the matching prefix without any edit.
    // The overlay is repainted here as well: moving the caret between lines
    // changes the suffix's screen cell while the store state stays identical,
    // so waiting for a state change would leave the suffix on the old row.
    const stopCaretListening = editorBridge.onCaretMove(() => {
      evaluateCaretPrefix()
      ghostLine.refresh()
    })
    // Leaving the proven composer (including blur to no editor) collapses
    // visible ghost text immediately. Bridge emits once per untrusted focus
    // transition, so its poll does not repeatedly clear valid state.
    const stopForeignFocusListening = editorBridge.onForeignEditorFocus(() => {
      suggestionStore.clear()
    })
    // Keep the composer hooks mounted across host-side textarea rebuilds
    // and same-instance listener-slot overwrites.
    editorBridge.watch()

    // The marker ref may run before its parent is attached. The bridge poll
    // reconciles the proof after mounting; no setup-time focused-editor hook.
    let stopIdentitySlot: (() => void) | undefined
    try {
      const identitySlotResult = context.ui?.slot?.({
        append: "prompt.footer",
        render: (properties: { sessionID?: string }) =>
          <box width={0} height={0} focusable={false} ref={(marker) => {
            if (marker && properties.sessionID) composerIdentity.register(properties.sessionID, marker)
          }} />,
      })
      if (typeof identitySlotResult?.dispose === "function") stopIdentitySlot = identitySlotResult.dispose
      else if (typeof identitySlotResult === "function") stopIdentitySlot = identitySlotResult
    } catch (error) {
      recordFailure("slot.prompt.footer", error)
      console.warn("[opencode-history-ghost] footer identity slot unavailable:", error)
    }

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
          // Retry on success, not on "we tried once": a failed keymap layer
          // registration must be retryable on the next app render instead of
          // being locked out forever by the `keymapCleanup === undefined` guard.
          if (keymapCleanup === undefined) {
            const registration = registerKeymap(context, {
              bridge: editorBridge,
              store: suggestionStore,
              settings,
              onToggle,
            })
            if (registration.suggestionLayerRegistered) keymapCleanup = registration
          }
          // Headless: the app slot is only the keymap provider anchor. Its own
          // render must return null — `append: "app"` lays out in NORMAL flow at
          // the bottom of the main column, so an absolutely-positioned overlay
          // mounted here anchors against the wrong container and lands
          // off-screen. The inline suffix is claimed on the composer region
          // instead (see the overlay slot below).
          return null
        },
      })
      if (typeof appSlotResult?.dispose === "function") stopAppSlot = appSlotResult.dispose
      else if (typeof appSlotResult === "function") stopAppSlot = appSlotResult
    } catch (error) {
      recordFailure("slot.app", error)
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
      recordFailure("slot.session.composer.top", error)
      console.warn("[opencode-history-ghost] composer slot registration failed:", error)
    }

    // ---- History refresh: jsonl mtime poll covers prompts that were just
    // submitted but are not in the DB yet (DESIGN §2).
    const historyRefreshTimer = setInterval(() => {
      if (disposed) return
      try {
        historySource.refresh()
        reassessChangedHistory()
      } catch (error) {
        recordFailure("history.refresh", error)
        console.warn("[opencode-history-ghost] history refresh failed:", error)
      }
    }, HISTORY_REFRESH_INTERVAL_MS)

    // ---- Cleanup: every registered resource is released exactly once,
    // whether the host calls the setup() return value or not.
    function disposeAll(): void {
      if (disposed) return
      disposed = true
      clearInterval(historyRefreshTimer)
      stopStateListening()
      stopInputListening()
      stopCaretListening()
      stopForeignFocusListening()
      editorBridge.dispose()
      composerIdentity.dispose()
      keymapCleanup?.()
      stopAppSlot?.()
      stopComposerSlot?.()
      stopIdentitySlot?.()
    }

    // Register this instance as the live one so a later reload disposes it
    // before stacking a new instance (hot-reload registry).
    registerActiveInstance(disposeAll)

    return disposeAll
  },
})


