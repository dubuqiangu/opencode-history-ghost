/** onToggle storage-fallback test (tui.tsx, defect-6 fix).
 *
 * When context.storage is absent, setup() must not crash: it falls back to a
 * plain in-memory settings object (defaultSettings) that the palette toggle
 * command mutates directly. This test proves that path:
 *   - setup() with a context that has NO storage succeeds;
 *   - the toggle layer's run() flips settings.enabled in memory;
 *   - the toggle also clears any visible suggestion (suggestionStore.clear()).
 *
 * The suggestion-store is mocked so it can observe both the settings object it
 * is handed and the clear() calls, without ever touching a user's history.
 */
import { mock, test, expect } from "bun:test"
import { createTestRenderer } from "@opentui/core/testing"
import { render } from "@opentui/solid"
import type { Context, KeymapLayer, SlotClaim } from "@opencode/plugin/tui/context"
import type { HistoryGhostSettings } from "../src/suggestion-store"

mock.module(import.meta.resolve("../src/history-source"), () => ({
  createHistorySource: () => ({ entries: () => [], refresh: () => {}, whenReady: () => Promise.resolve(), readStats: () => ({ jsonlReads: 0, databaseLoads: 0 }) }),
}))

interface ObservedStore {
  clearCount: number
  capturedSettings: HistoryGhostSettings | undefined
  onStateChange(listener: () => void): () => void
  clear(): void
  evaluate(raw: string): void
  reassess(raw: string): void
  cycle(direction: 1 | -1): void
  dismiss(): void
  current(): null
  hasSuggestion(): boolean
  state(): null
}
const observedStores: ObservedStore[] = []
mock.module(import.meta.resolve("../src/suggestion-store"), () => ({
  createSuggestionStore: (_history: () => unknown, settings: HistoryGhostSettings): ObservedStore => {
    const observedStore: ObservedStore = {
      clearCount: 0,
      capturedSettings: settings,
      onStateChange: () => () => {},
      clear: () => { observedStore.clearCount += 1 },
      evaluate: () => {},
      reassess: () => {},
      cycle: () => {},
      dismiss: () => {},
      current: () => null,
      hasSuggestion: () => false,
      state: () => null,
    }
    observedStores.push(observedStore)
    return observedStore
  },
}))

const { default: plugin } = await import("../src/tui")

test("onToggle storage fallback flips in-memory settings and clears suggestions", async () => {
  const testRenderer = await createTestRenderer({ width: 80, height: 8 })
  const slotClaims: SlotClaim[] = []
  const capturedLayers: KeymapLayer[] = []
  try {
    const context = {
      renderer: testRenderer.renderer,
      // NO storage field: setup must not crash and must fall back to in-memory.
      ui: {
        router: { current: () => ({ type: "home" as const }) },
        slot: (claim: SlotClaim) => {
          slotClaims.push(claim)
          return () => {}
        },
      },
      keymap: {
        layer: (factory: () => KeymapLayer): void => { capturedLayers.push(factory()) },
        mode: { current: () => "normal" },
      },
    } as unknown as Context

    const cleanupPlugin = plugin.setup(context) as () => void
    expect(typeof cleanupPlugin).toBe("function")

    // Keymap registration happens inside the app slot's render, so drive it.
    const appSlot = slotClaims.find((claim) => "append" in claim && claim.append === "app")
    if (!appSlot) throw new Error("FAIL: app slot was not claimed")
    await render(() => appSlot.render({}), testRenderer.renderer)

    // Two layers (suggestion shortcuts + palette toggle) were registered.
    expect(capturedLayers.length).toBe(2)
    const paletteLayer = capturedLayers[1]!
    const toggleCommand = paletteLayer.commands?.find((command) => command.id === "history-ghost.toggle")
    expect(toggleCommand).toBeDefined()
    expect(toggleCommand?.run).toBeTypeOf("function")

    // The mocked store received the in-memory default settings object (storage
    // was absent) and has not yet seen a clear.
    const observedStore = observedStores[observedStores.length - 1]!
    expect(observedStore.capturedSettings).toBeDefined()
    const initialState = observedStore.capturedSettings!.enabled
    const clearCountBefore = observedStore.clearCount

    // Toggling once flips enabled in memory and clears any visible suggestion.
    toggleCommand!.run()
    expect(observedStore.capturedSettings!.enabled).toBe(!initialState)
    expect(observedStore.clearCount).toBe(clearCountBefore + 1)

    // Toggling back flips again and clears once more (still no storage API).
    toggleCommand!.run()
    expect(observedStore.capturedSettings!.enabled).toBe(initialState)
    expect(observedStore.clearCount).toBe(clearCountBefore + 2)
  } finally {
    await testRenderer.dispose()
  }
})