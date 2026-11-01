/** Reload-registry test (optimization: tleclaire/opencode-autocomplete approach).
 *
 * The host may re-run setup() on the same process (plugin reload, live-sync,
 * config touch) without tearing down the previous instance first. The TUI entry
 * keeps ONE disposer per plugin id on globalThis and runs it before the new
 * instance registers, so a reload cannot stack timers/listeners/slots/keymaps.
 *
 * Isolated synthetic test: never reads a user's history. We run the real
 * plugin.setup() twice in-process and assert the registry transitions so the
 * second instance replaces the first (reload guard) and disposal is idempotent.
 *
 * PROOF OF DISPOSAL: the previous version only asserted registry bookkeeping —
 * if disposeRegisteredInstance() were deleted, the test still passed. Here the
 * suggestion-store is mocked to count active onStateChange subscriptions. The
 * first setup subscribes the UI-pipeline listener on store A (via stopStateListening
 * inside disposeAll). A second setup MUST run the first disposeAll, which calls
 * stopStateListening → store A's active subscriptions drop to zero. Removing the
 * reload-dispose call leaves store A subscribed and this test FAILS.
 */
import { mock, test, expect } from "bun:test"
import { createTestRenderer } from "@opentui/core/testing"
import type { Context, KeymapLayer, SlotClaim } from "@opencode/plugin/tui/context"

const RELOAD_REGISTRY_KEY = "opencode-history-ghost.activeInstance"
const registry = (globalThis as Record<string, unknown>)
// Isolate from any earlier run in this process.
registry[RELOAD_REGISTRY_KEY] = undefined

// Synthetic history source: the setup never reads a user's opencode.db/jsonl.
mock.module(import.meta.resolve("../src/history-source"), () => ({
  createHistorySource: () => ({ entries: () => [], refresh: () => {}, whenReady: () => Promise.resolve(), readStats: () => ({ jsonlReads: 0, databaseLoads: 0 }) }),
}))

// Mock the store to observe onStateChange subscription lifecycle. Each created
// store exposes activeSubscriptionCount() so the test can prove disposal.
interface TrackedStore {
  onStateChange(listener: () => void): () => void
  activeSubscriptionCount(): number
  evaluate(raw: string): void
  reassess(raw: string): void
  cycle(direction: 1 | -1): void
  clear(): void
  dismiss(): void
  current(): null
  hasSuggestion(): boolean
  state(): null
}
const createdStores: TrackedStore[] = []
mock.module(import.meta.resolve("../src/suggestion-store"), () => ({
  createSuggestionStore: (): TrackedStore => {
    const activeListeners = new Set<() => void>()
    const trackedStore: TrackedStore = {
      onStateChange(listener: () => void): () => void {
        activeListeners.add(listener)
        return () => { activeListeners.delete(listener) }
      },
      activeSubscriptionCount: () => activeListeners.size,
      evaluate: () => {},
      reassess: () => {},
      cycle: () => {},
      clear: () => {},
      dismiss: () => {},
      current: () => null,
      hasSuggestion: () => false,
      state: () => null,
    }
    createdStores.push(trackedStore)
    return trackedStore
  },
}))

const { default: plugin } = await import("../src/tui")

function makeContext(testRenderer: ReturnType<typeof createTestRenderer>): Context {
  const slotClaims: SlotClaim[] = []
  const capturedLayers: KeymapLayer[] = []
  return {
    renderer: testRenderer.renderer,
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
}

test("registering a second setup disposes the first instance (reload guard)", async () => {
  const testRenderer = await createTestRenderer({ width: 80, height: 8 })
  try {
    const context = makeContext(testRenderer)
    const storeCountBefore = createdStores.length
    const firstDispose = plugin.setup(context) as () => void
    expect(typeof firstDispose).toBe("function")
    // After the first setup, the registry holds that instance's disposer.
    const firstRegistered = registry[RELOAD_REGISTRY_KEY]
    expect(typeof firstRegistered).toBe("function")

    // The first instance created exactly one tracked store, and the UI-pipeline
    // listener keeps it subscribed (stopStateListening not yet run).
    const storesAfterFirst = createdStores.slice(storeCountBefore)
    expect(storesAfterFirst.length).toBe(1)
    const firstStore = storesAfterFirst[0]!
    expect(firstStore.activeSubscriptionCount()).toBeGreaterThan(0)

    // Registering a SECOND instance must replace (and dispose) the first.
    const secondDispose = plugin.setup(context) as () => void
    expect(typeof secondDispose).toBe("function")
    const secondRegistered = registry[RELOAD_REGISTRY_KEY]
    // The registry now points at the second instance's disposer.
    expect(secondRegistered).toBe(secondDispose)
    // And it is NOT the first disposer any more — reload swapped it.
    expect(secondRegistered).not.toBe(firstRegistered)

    // PROOF OF DISPOSAL: the first instance's UI-pipeline listener was torn down
    // by disposeAll (via stopStateListening) during the second setup. If
    // disposeRegisteredInstance() were deleted, this subscription would survive.
    expect(firstStore.activeSubscriptionCount()).toBe(0)

    // The second instance's own store is still subscribed (its disposeAll has
    // not run yet) — the reload replaced rather than stacked or dropped.
    const secondStore = createdStores[createdStores.length - 1]!
    expect(secondStore).not.toBe(firstStore)
    expect(secondStore.activeSubscriptionCount()).toBeGreaterThan(0)

    // Both disposers are idempotent: calling the first again (already run by
    // the reload guard) and the second twice must not throw.
    expect(() => { (firstDispose as () => void)(); (secondDispose as () => void)(); (secondDispose as () => void)() }).not.toThrow()
    // After the second instance is disposed explicitly, its listener also goes.
    expect(secondStore.activeSubscriptionCount()).toBe(0)
  } finally {
    await testRenderer.dispose()
  }
})