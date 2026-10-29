import { BoxRenderable, TextareaRenderable } from "@opentui/core"
import { createTestRenderer } from "@opentui/core/testing"
import { createComposerIdentity } from "../src/composer-identity"
import { createEditorBridge, runIntegrityPollOnce } from "../src/editor-bridge"
import { registerKeymap } from "../src/keymap"
import { createSuggestionStore, type HistoryGhostSettings } from "../src/suggestion-store"

const settings: HistoryGhostSettings = {
  enabled: true, acceptKey: "tab", minChars: 3, maxCandidates: 10,
  maxEntries: 2000, maxTextLength: 2000, excludePrefixes: ["/", "@"],
}
let failures = 0
function check(description: string, condition: boolean): void {
  console.log(`  ${condition ? "PASS" : "FAIL"}  ${description}`)
  if (!condition) failures += 1
}

const setup = await createTestRenderer({ width: 110, height: 12 })
const { renderer } = setup
const composer = new TextareaRenderable(renderer, { id: "composer", width: 100, height: 3 })
const foreignEditor = new TextareaRenderable(renderer, { id: "foreign", width: 100, height: 3 })
const root = new BoxRenderable(renderer, { id: "prompt" })
const border = new BoxRenderable(renderer, { id: "input-border" })
const padding = new BoxRenderable(renderer, { id: "input-padding" })
const footer = new BoxRenderable(renderer, { id: "footer" })
const marker = new BoxRenderable(renderer, { id: "marker", width: 0, height: 0 })
root.add(border); border.add(padding); padding.add(composer)
padding.add(new BoxRenderable(renderer, { id: "metadata" }))
root.add(footer); footer.add(marker)
renderer.root.add(root); renderer.root.add(foreignEditor)
let inputMode = "normal"
const layerFactories: Array<() => unknown> = []
const context = {
  renderer,
  ui: { router: { current: () => ({ type: "session", sessionID: "active" }) } },
  keymap: {
    layer(factory: () => unknown) { layerFactories.push(factory) },
    mode: { current: () => inputMode },
  },
}
const identity = createComposerIdentity(context)
identity.register("active", marker)
const bridge = createEditorBridge(context, identity)
const store = createSuggestionStore(() => [
  { text: "abcdef", lower: "abcdef" },
  { text: "你好世界", lower: "你好世界" },
  { text: "👩‍💻code", lower: "👩‍💻code" },
  { text: "e\u0301clair", lower: "e\u0301clair" },
  { text: "abc\nthere", lower: "abc\nthere" },
], settings)
const stopInput = bridge.onInput(() => {
  const prefix = bridge.caretPrefix()
  if (prefix === null) store.clear()
  else store.evaluate(prefix)
})
const stopCaret = bridge.onCaretMove(() => {
  const prefix = bridge.caretPrefix()
  if (prefix === null) store.clear()
  else store.evaluate(prefix)
})
const stopForeign = bridge.onForeignEditorFocus(() => store.clear())
let stopKeymap: (() => void) | undefined
try {
  composer.focus()
  runIntegrityPollOnce(bridge)
  stopKeymap = registerKeymap(context, { bridge, store, settings, onToggle: () => {} })
  const layer = layerFactories.map((factory) => factory() as { enabled(): boolean; commands: Array<{ id: string; run(): unknown }> })
    .find((registeredLayer) => registeredLayer.commands.some((command) => command.id === "history-ghost.accept"))!
  const accept = layer.commands.find((command) => command.id === "history-ghost.accept")!
  async function setCaretBeforeSuffix(text: string, suffix: string): Promise<void> {
    composer.replaceText("")
    composer.insertText(text)
    const prefix = text.slice(0, text.length - suffix.length)
    composer.cursorOffset = composer.editBuffer.measureText(prefix)
    await setup.renderOnce()
    // Programmatic setter does not emit onCursorChange in the SDK; an actual
    // cursor move does. Move away and back to simulate the terminal action.
    composer.moveCursorLeft()
    composer.moveCursorRight()
  }

  await setCaretBeforeSuffix("abcXYZ", "XYZ")
  check("middle caret evaluates only abc, not XYZ", bridge.caretPrefix() === "abc" && store.state()?.input === "abc" && store.current()?.text === "abcdef")
  check("Tab replaces entire abc|XYZ buffer with abcdef", accept.run() !== false && composer.plainText === "abcdef")

  await setCaretBeforeSuffix("abcXYZ", "XYZ")
  composer.moveCursorLeft()
  await setup.renderOnce()
  check("moving left re-evaluates the new prefix immediately", bridge.caretPrefix() === "ab" && store.state() === null)
  composer.moveCursorRight()
  await setup.renderOnce()
  check("moving right re-evaluates matching prefix immediately", store.state()?.input === "abc")
  composer.cursorOffset = composer.editBuffer.measureText("abcXYZ")
  composer.moveCursorLeft(); composer.moveCursorRight()
  await setup.renderOnce()
  check("moving to end re-evaluates whole text, not old prefix", store.state() === null)

  for (const [text, suffix, expectedPrefix, candidate] of [
    ["你好世XYZ", "XYZ", "你好世", "你好世界"],
    ["👩‍💻codXYZ", "XYZ", "👩‍💻cod", "👩‍💻code"],
    ["e\u0301clXYZ", "XYZ", "e\u0301cl", "e\u0301clair"],
    ["abc\nthXYZ", "XYZ", "abc\nth", "abc\nthere"],
  ]) {
    await setCaretBeforeSuffix(text, suffix)
    check(`SDK cell offset retrieves prefix for ${JSON.stringify(expectedPrefix)}`, bridge.caretPrefix() === expectedPrefix && store.current()?.text === candidate)
    check(`Tab replaces whole buffer for ${JSON.stringify(expectedPrefix)}`, accept.run() !== false && composer.plainText === candidate)
  }

  await setCaretBeforeSuffix("abcXYZ", "XYZ")
  composer.onCursorChange = undefined // simulate lost listener and a silent host cursor move
  composer.cursorOffset = composer.editBuffer.measureText("abcX")
  check("stale caret position yields Tab", accept.run() === false && composer.plainText === "abcXYZ")
  runIntegrityPollOnce(bridge)
  await setCaretBeforeSuffix("abcXYZ", "XYZ")
  composer.onContentChange = undefined // simulate silent foreign edit without reevaluation
  composer.replaceText("abcZZZ")
  composer.cursorOffset = composer.editBuffer.measureText("abc")
  check("stale full text yields Tab even if prefix matches", accept.run() === false && composer.plainText === "abcZZZ" && bridge.caretPrefix() === "abc")
  runIntegrityPollOnce(bridge)
  await setCaretBeforeSuffix("abcXYZ", "XYZ")
  inputMode = "autocomplete"
  check("host autocomplete owns Tab", !layer.enabled() && accept.run() === false && composer.plainText === "abcXYZ")
  inputMode = "modal"
  check("host modal owns Tab", !layer.enabled() && accept.run() === false && composer.plainText === "abcXYZ")
  inputMode = "normal"
  foreignEditor.focus()
  check("foreign editor with same input cannot be replaced", accept.run() === false && composer.plainText === "abcXYZ")
} finally {
  stopKeymap?.()
  stopInput(); stopCaret(); stopForeign()
  bridge.dispose(); identity.dispose()
  await setup.dispose()
}
console.log(failures === 0 ? "测试结论：全部 PASS" : `测试结论：存在 FAIL（${failures} 处）`)
if (failures > 0) process.exitCode = 1
