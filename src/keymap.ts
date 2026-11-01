// Keymap layer for opencode-history-ghost (T8, DESIGN §3.6).
//
// MUST be registered from inside a slot render — calling it directly from
// setup() throws "Keymap.Provider is missing" on the host (verified with the
// opencode-autocontinue plugin, which registers its layer from the first
// `app` slot render for exactly this reason).
//
// The suggestion shortcut layer is globally scoped but enabled only while all three hold:
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
// The palette toggle lives in a separate global, unbound layer so it remains
// discoverable without a suggestion or composer focus.
//
// RUN-TIME CONSISTENCY GUARD: bridge.current() synchronously limits focus
// to the trusted composer; full text, native prefix and offset must also
// match the snapshot captured when the candidate was shown.

import type { EditorBridge, EditorSnapshot } from "./editor-bridge"
import type { HistoryGhostSettings, SuggestionStoreApi } from "./suggestion-store"
import { recordFailure } from "./probe-log"

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
  } catch (error) {
    recordFailure("keymap.mode", error)
    return ""
  }
}

/** Host-owned completion and modal scopes must retain their keyboard input. */
function isHostOverlayMode(keymap: KeymapLike): boolean {
  const inputMode = safeInputMode(keymap)
  return inputMode === "autocomplete" || inputMode === "modal"
}

/**
 * Validates that the editor state still matches the snapshot captured when the
 * candidate was shown, and that the candidate is still keyed to the live caret
 * prefix. The snapshot is refreshed on every store state change, and the fast
 * path commits too, so it never lags a real keystroke; the text/offset equality
 * here is what stops a silent foreign edit (e.g. a listener slot the host
 * overwrote) from accepting a suggestion that no longer fits the buffer.
 */
function suggestionMatchesFocusedEditor(deps: KeymapDeps, candidateSnapshot: EditorSnapshot | null): boolean {
  // The layer's `enabled` no longer reads plugin settings (store state is not a
  // reactive signal there), so the master switch must be honoured here.
  if (!deps.settings.enabled) return false
  const suggestionState = deps.store.state()
  if (!suggestionState) return false
  const current = deps.bridge.caretSnapshot()
  if (!current || !candidateSnapshot) return false
  if (current.editor !== candidateSnapshot.editor) return false
  if (current.text !== candidateSnapshot.text || current.prefix !== candidateSnapshot.prefix || current.offset !== candidateSnapshot.offset) return false
  return current.prefix.trim() === suggestionState.input
}

/** True when the caret sits at the very end of the composer text. */
function caretAtTextEnd(snapshot: EditorSnapshot): boolean {
  return snapshot.prefix === snapshot.text
}

/**
 * Registers the suggestion shortcuts and palette toggle in separate layers.
 * Returns a cleanup function that unregisters both best-effort (a no-op when
 * the host owns layer lifetime).
 *
 * The cleanup carries a `suggestionLayerRegistered` flag: a sync throw from
 * `keymap.layer` leaves the shortcuts unbound, and the caller must be able to
 * see that and retry on a later slot render instead of assuming success.
 */
export interface KeymapRegistration {
  (): void
  /** True when the suggestion-shortcut layer was accepted by the host. */
  readonly suggestionLayerRegistered: boolean
}

export function registerKeymap(context: unknown, deps: KeymapDeps): KeymapRegistration {
  const keymap = (context as { keymap?: KeymapLike } | undefined)?.keymap
  if (!keymap || typeof keymap.layer !== "function") {
    console.warn(`${LOG_PREFIX} keymap API unavailable; history-ghost shortcuts are disabled`)
    const unavailableCleanup = (): void => {}
    Object.defineProperty(unavailableCleanup, "suggestionLayerRegistered", {
      value: false,
      enumerable: true,
    })
    return unavailableCleanup as KeymapRegistration
  }

  // The candidate is keyed to the editor state at the moment it was shown.
  // Refresh that snapshot on every store change so dispatch can verify the
  // buffer did not silently drift under the suggestion.
  let candidateSnapshot = deps.store.hasSuggestion() ? deps.bridge.caretSnapshot() : null
  const stopSnapshotListening = deps.store.onStateChange(() => {
    candidateSnapshot = deps.store.hasSuggestion() ? deps.bridge.caretSnapshot() : null
  })

  const requestRender = (): void => {
    try {
      ;(context as { renderer?: { requestRender?: () => void } } | undefined)?.renderer?.requestRender?.()
    } catch {
      // Repaint scheduling is best-effort.
    }
  }

  const layerDisposers: Array<() => void> = []
  let suggestionLayerRegistered = false
  try {
    const layerResult = keymap.layer(() => ({
      mode: "global",
      // NO `target` and NO `enabled` here. The host resolves a layer's `target`
      // thunk to a STATIC reference once, untracked, and REPLACES the layer with
      // undefined — i.e. removes it — when that call returns null. `target:
      // () => deps.bridge.current()` is null until the composer is proven, so
      // the whole layer was deleted at activation and every shortcut died
      // (real-machine: Tab/right/ctrl+up/ctrl+down all no-ops). This mirrors the
      // two working same-host plugins (opencode-autocontinue, opencode-snippets),
      // which declare only `mode: "global"` + `commands` and gate inside run().
      // All real gating stays in each run() below.
      //
      // The `bindings` array is declared explicitly as a belt-and-suspenders:
      // the host also consults it to know these command ids are keyboard
      // bindings (tleclaire/opencode-autocomplete, whose layer would otherwise
      // only expose palette entries). It must list exactly the command ids that
      // carry a `bind` below so discovery and dispatch agree.
      bindings: [
        "history-ghost.accept",
        "history-ghost.accept-forward",
        "history-ghost.cycle-next",
        "history-ghost.cycle-prev",
        "history-ghost.dismiss",
      ],
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
            if (isHostOverlayMode(keymap) || !suggestionMatchesFocusedEditor(deps, candidateSnapshot)) return false
            // 中段光标也接受：用户确认的契约是 abc|XYZ 按 Tab 后整段变候选文本
            // （TEST caret-prefix-accept 固定该行为）。
            // Consumed on success (no return value); yielded back to the host
            // only when the editor write failed so Tab still does something.
            if (!deps.bridge.acceptFullText(candidate.text)) return false
            deps.store.clear()
            requestRender()
          },
        },
        {
          // "right" is a second accept key, not a replacement for acceptKey.
          // It only fires with the caret past the last typed character, so
          // ordinary caret movement keeps working untouched.
          id: "history-ghost.accept-forward",
          title: "History Ghost: 接受建议（右箭头）",
          bind: "right",
          run: () => {
            if (isHostOverlayMode(keymap)) return false
            if (!suggestionMatchesFocusedEditor(deps, candidateSnapshot)) return false
            const liveSnapshot = deps.bridge.caretSnapshot()
            if (!liveSnapshot || !caretAtTextEnd(liveSnapshot)) return false
            const candidate = deps.store.current()
            if (!candidate) return false
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
            if (isHostOverlayMode(keymap) || !suggestionMatchesFocusedEditor(deps, candidateSnapshot)) return false
            deps.store.cycle(1)
            requestRender()
          },
        },
        {
          id: "history-ghost.cycle-prev",
          title: "History Ghost: 上一条建议",
          bind: "ctrl+up",
          run: () => {
            if (isHostOverlayMode(keymap) || !suggestionMatchesFocusedEditor(deps, candidateSnapshot)) return false
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
            if (isHostOverlayMode(keymap) || !suggestionMatchesFocusedEditor(deps, candidateSnapshot)) return false
            deps.store.dismiss()
            requestRender()
          },
        },
      ],
    }))
    if (typeof (layerResult as { dispose?: unknown })?.dispose === "function") {
      layerDisposers.push((layerResult as { dispose: () => void }).dispose)
    } else if (typeof layerResult === "function") {
      layerDisposers.push(layerResult as () => void)
    }
    suggestionLayerRegistered = true
  } catch (error) {
    recordFailure("keymap.suggestion", error)
    console.warn(`${LOG_PREFIX} suggestion keymap layer registration failed:`, error)
  }

  // Layer.enabled gates palette discovery too; keep this unbound command
  // outside the suggestion-only layer so it is reachable with empty history,
  // a disabled master switch, or focus outside the composer.
  try {
    const toggleLayerResult = keymap.layer(() => ({
      mode: "global",
      commands: [{
        id: "history-ghost.toggle",
        title: "History Ghost: 开关历史建议",
        palette: true,
        run: () => { deps.onToggle() },
      }],
    }))
    if (typeof (toggleLayerResult as { dispose?: unknown })?.dispose === "function") {
      layerDisposers.push((toggleLayerResult as { dispose: () => void }).dispose)
    } else if (typeof toggleLayerResult === "function") {
      layerDisposers.push(toggleLayerResult as () => void)
    }
  } catch (error) {
    recordFailure("keymap.toggle", error)
    console.warn(`${LOG_PREFIX} palette keymap layer registration failed:`, error)
  }

  const cleanup = (): void => {
    stopSnapshotListening()
    for (const disposeLayer of layerDisposers.reverse()) {
      try {
        disposeLayer()
      } catch (error) {
        recordFailure("keymap.dispose", error)
        console.warn(`${LOG_PREFIX} keymap layer unregistration failed:`, error)
      }
    }
  }
  Object.defineProperty(cleanup, "suggestionLayerRegistered", {
    value: suggestionLayerRegistered,
    enumerable: true,
  })
  return cleanup as KeymapRegistration
}
