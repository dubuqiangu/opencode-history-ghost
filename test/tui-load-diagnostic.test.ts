/** Isolated TUI slot/keymap diagnostic; never reads a user's history. */
import { mock } from "bun:test"
import { createTestRenderer } from "@opentui/core/testing"
import { render } from "@opentui/solid"
import type { Context, KeymapLayer, SlotClaim } from "@opencode/plugin/tui/context"

mock.module(import.meta.resolve("../src/history-source"), () => ({
  createHistorySource: () => ({ entries: () => [], refresh: () => {} }),
}))

const { default: plugin } = await import("../src/tui")
const testRenderer = await createTestRenderer({ width: 80, height: 8 })
const slotClaims: SlotClaim[] = []
const capturedLayers: KeymapLayer[] = []
let cleanupPlugin: (() => void) | undefined

function isEnabled(layer: KeymapLayer): boolean {
  return typeof layer.enabled === "function" ? layer.enabled() : layer.enabled !== false
}

try {
  // This is the SDK's actual slot(Claim): cleanup and keymap.layer(factory): void
  // shape. Only the host's private slot scheduler/keymap registry is replaced.
  const context = {
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

  cleanupPlugin = plugin.setup(context) as () => void
  const appSlot = slotClaims.find((claim) => "append" in claim && claim.append === "app")
  if (!appSlot) throw new Error("FAIL: app slot was not claimed")
  await render(() => appSlot.render({}), testRenderer.renderer)
  if (capturedLayers.length !== 2) throw new Error(`FAIL: expected shortcut + palette layers, got ${capturedLayers.length}`)
  const [shortcutLayer, paletteLayer] = capturedLayers
  const toggle = paletteLayer.commands?.find((command) => command.id === "history-ghost.toggle")
  if (toggle?.palette !== true) throw new Error("FAIL: palette toggle command was not declared")
  if (shortcutLayer.commands?.some((command) => command.id === "history-ghost.toggle")) throw new Error("FAIL: duplicate/unreachable palette command on shortcut layer")
  if (paletteLayer.commands?.some((command) => command.bind)) throw new Error("FAIL: palette layer must not bind Tab/Esc/cycle")
  if (paletteLayer.target) throw new Error("FAIL: palette layer must not require composer focus")
  // The suggestion layer declares its keyboard bindings explicitly so the host
  // can discover which command ids are keyboard bindings (belt-and-suspenders
  // alongside each command's `bind`). It must list exactly the five shortcut ids.
  const expectedBindings = [
    "history-ghost.accept",
    "history-ghost.accept-forward",
    "history-ghost.cycle-next",
    "history-ghost.cycle-prev",
    "history-ghost.dismiss",
  ]
  const actualBindings = shortcutLayer.bindings ?? []
  if (JSON.stringify(actualBindings) !== JSON.stringify(expectedBindings)) {
    throw new Error(`FAIL: suggestion layer bindings = ${JSON.stringify(actualBindings)}, expected ${JSON.stringify(expectedBindings)}`)
  }
  console.log("PASS: real Solid app slot mounts; SDK-shaped palette-only layer declares the toggle")

  // The shortcut layer must stay REACHABLE even with no suggestion: the host
  // evaluates `enabled` reactively and the store is plain mutable state (not a
  // signal), so gating on "a suggestion is visible" froze the layer at its
  // first value and Tab never dispatched again (the production bug). The
  // suggestion condition is enforced inside each run() instead, which returns
  // false to yield the key back to the host.
  const shortcutEnabled = isEnabled(shortcutLayer)
  const paletteEnabled = isEnabled(paletteLayer)
  console.log(`Observed: toggle.palette=${toggle.palette}, shortcut.enabled=${shortcutEnabled}, palette.enabled=${paletteEnabled} with no suggestion`)
  if (!shortcutEnabled || !paletteEnabled) throw new Error("FAIL: both layers must stay reachable; per-run checks gate the suggestion")
  if (shortcutLayer.commands?.filter((command) => command.bind).length !== 5) throw new Error("FAIL: expected five bound shortcuts (accept, accept-forward, cycle x2, dismiss)")
  // With no suggestion, every shortcut must decline instead of consuming key.
  const acceptCommand = shortcutLayer.commands?.find((command) => command.id === "history-ghost.accept")
  const acceptForwardCommand = shortcutLayer.commands?.find((command) => command.id === "history-ghost.accept-forward")
  const cycleNextCommand = shortcutLayer.commands?.find((command) => command.id === "history-ghost.cycle-next")
  const dismissCommand = shortcutLayer.commands?.find((command) => command.id === "history-ghost.dismiss")
  for (const command of [acceptCommand, acceptForwardCommand, cycleNextCommand, dismissCommand]) {
    if (!command) throw new Error("FAIL: expected shortcut command is missing")
    if (command.run() !== false) throw new Error(`FAIL: ${command.id} must yield the key when there is no suggestion`)
  }
  console.log("PASS: empty history keeps both layers reachable; every shortcut yields the key")
  toggle.run()
  if (!isEnabled(paletteLayer) || !isEnabled(shortcutLayer)) throw new Error("FAIL: palette toggle becomes unreachable after switching suggestions off")
  toggle.run()
  if (!isEnabled(paletteLayer) || !isEnabled(shortcutLayer)) throw new Error("FAIL: palette toggle becomes unreachable after switching suggestions on")
  console.log("PASS: toggling the master switch never removes palette access")
} finally {
  cleanupPlugin?.()
  testRenderer.renderer.destroy()
}
