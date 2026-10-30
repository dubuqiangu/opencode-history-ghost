import { BoxRenderable, TextareaRenderable } from "@opentui/core"
import { createTestRenderer } from "@opentui/core/testing"
import { createEditorBridge, runIntegrityPollOnce } from "../src/editor-bridge"
import { createComposerIdentity } from "../src/composer-identity"
import { registerKeymap } from "../src/keymap"
import { createSuggestionStore, type HistoryGhostSettings } from "../src/suggestion-store"

let failures = 0
function check(description: string, condition: boolean): void {
  console.log(`  ${condition ? "PASS" : "FAIL"}  ${description}`)
  if (!condition) failures += 1
}

const settings: HistoryGhostSettings = {
  enabled: true, acceptKey: "tab", minChars: 3, maxCandidates: 5,
  maxEntries: 2000, maxTextLength: 2000, excludePrefixes: ["/", "@"],
}

function promptFixture(renderer: Awaited<ReturnType<typeof createTestRenderer>>["renderer"], editor: TextareaRenderable, identity: ReturnType<typeof createComposerIdentity>, sessionID = "active") {
  const root = new BoxRenderable(renderer, { id: `root-${editor.id}` })
  const border = new BoxRenderable(renderer, { id: `border-${editor.id}` })
  const padding = new BoxRenderable(renderer, { id: `padding-${editor.id}` })
  const footer = new BoxRenderable(renderer, { id: `footer-${editor.id}` })
  const marker = new BoxRenderable(renderer, { id: `marker-${editor.id}`, width: 0, height: 0 })
  root.add(border); border.add(padding); padding.add(editor); padding.add(new BoxRenderable(renderer, { id: `metadata-${editor.id}` })); root.add(footer); footer.add(marker)
  renderer.root.add(root); identity.register(sessionID, marker)
}

async function realRendererScenarios(): Promise<void> {
  const setup = await createTestRenderer({ width: 110, height: 12 })
  const { renderer } = setup
  const composer = new TextareaRenderable(renderer, { id: "trusted-composer", width: 100, height: 2 })
  const dialog = new TextareaRenderable(renderer, { id: "foreign-dialog", width: 100, height: 2 })
  const nextComposer = new TextareaRenderable(renderer, { id: "rebuilt-composer", width: 100, height: 2 })
  const store = createSuggestionStore(() => [{ text: "hello", lower: "hello" }], settings)
  let inputMode = "normal"
  const capturedLayers: Array<() => unknown> = []
  const toggleCalls = { count: 0 }
  const context = {
    renderer,
    ui: { router: { current: () => ({ type: "session", sessionID: "active" }) } },
    keymap: { layer(factory: () => unknown) { capturedLayers.push(factory) }, mode: { current: () => inputMode } },
  }
  const identity = createComposerIdentity(context)
  const bridge = createEditorBridge(context, identity)
  const foreignFocus = { count: 0 }
  let stopKeymap: (() => void) | undefined
  try {
    promptFixture(renderer, composer, identity)
    renderer.root.add(dialog)
    composer.focus()
    bridge.onInput((text) => store.evaluate(text))
    bridge.onCaretMove((atEnd) => { if (!atEnd) store.clear() })
    bridge.onForeignEditorFocus(() => { foreignFocus.count += 1 })
    runIntegrityPollOnce(bridge)
    stopKeymap = registerKeymap(context, { bridge, store, settings, onToggle: () => { toggleCalls.count += 1 } })
    type CapturedLayer = {
      commands: Array<{ id: string; palette?: boolean; run: () => unknown }>
    }
    const registeredLayers = capturedLayers.map((factory) => factory() as CapturedLayer)
    const layer = registeredLayers.find((registeredLayer) => registeredLayer.commands.some((command) => command.id === "history-ghost.accept"))!
    const paletteLayer = registeredLayers.find((registeredLayer) => registeredLayer.commands.some((command) => command.id === "history-ghost.toggle"))!
    // Shortcuts are gated inside run(), not by a static layer `target`/`enabled`:
    // the host resolves `target` once and REMOVES the layer when it yields null,
    // which killed every key on the real machine. "Target" now maps to the live
    // proven-editor check, and the layer must simply stay registered.
    const suggestionTarget = () => bridge.current()
    const suggestionLayerPresent = () => layer !== undefined
    const paletteReachable = () => paletteLayer !== undefined
    const accept = layer.commands.find((command) => command.id === "history-ghost.accept")!
    const dismiss = layer.commands.find((command) => command.id === "history-ghost.dismiss")!
    const next = layer.commands.find((command) => command.id === "history-ghost.cycle-next")!
    const previous = layer.commands.find((command) => command.id === "history-ghost.cycle-prev")!
    const toggle = paletteLayer?.commands.find((command) => command.id === "history-ghost.toggle")

    check("toggle registered separately from suggestion-only commands", registeredLayers.length >= 2 && layer !== paletteLayer && !layer.commands.some((command) => command.id === "history-ghost.toggle") && paletteLayer?.commands.every((command) => command.id === "history-ghost.toggle"))
    // The layer stays REGISTERED with no suggestion: a static `target`/`enabled`
    // gated on store state either froze the layer or (target) got the layer
    // removed by the host. The suggestion condition lives in run(), which yields
    // the key. Registration itself must therefore never depend on state.
    check("suggestion layer reachable without suggestion", suggestionLayerPresent())
    const acceptForward = layer.commands.find((command) => command.id === "history-ghost.accept-forward")!
    check("every shortcut yields the key without a suggestion", [accept, acceptForward, dismiss, next, previous].every((command) => command.run() === false))
    check("palette toggle reachable without suggestion", Boolean(toggle?.palette && paletteReachable()))
    if (toggle && paletteReachable()) toggle.run()
    check("palette toggle dispatches without suggestion", toggleCalls.count === 1)

    composer.insertText("hel")
    await setup.renderOnce()
    check("composer active and suggestion ready", suggestionTarget() === composer && store.hasSuggestion() && suggestionLayerPresent())
    for (const blockedMode of ["autocomplete", "modal"]) {
      inputMode = blockedMode
      check(`${blockedMode} keeps the layer present without changing focus`, suggestionLayerPresent() && suggestionTarget() === composer)
      check(`${blockedMode} Tab/Esc/cycle all yield at dispatch`, [accept, dismiss, next, previous].every((command) => command.run() === false) && store.hasSuggestion() && composer.plainText === "hel")
    }
    inputMode = "normal"
    check("mode-only return restores suggestion keymap", suggestionLayerPresent() && suggestionTarget() === composer)
    check("palette toggle remains exposed in separate layer", toggle !== undefined && paletteReachable())

    dialog.focus()
    dialog.insertText("hel")
    await setup.renderOnce()
    check("dialog text identical to composer", dialog.plainText === composer.plainText)
    check("dialog typing does not alter composer suggestion", store.hasSuggestion())
    check("dialog never becomes keymap target without polling", suggestionTarget() === null)
    check("foreign input is not exposed by bridge", bridge.current() === null && bridge.inputText() === null)
    check("dialog Tab yields to host", accept.run() === false && dialog.plainText === "hel")
    check("dialog Esc yields to host", dismiss.run() === false && store.hasSuggestion())
    check("dialog cannot receive acceptFullText", bridge.acceptFullText("hello") === false && dialog.plainText === "hel")
    runIntegrityPollOnce(bridge)
    check("poll reports foreign editor but never adopts it", foreignFocus.count > 0 && bridge.current() === null)

    composer.focus()
    check("composer becomes target again", suggestionTarget() === composer)
    composer.replaceText("")
    composer.insertText("你好世")
    await setup.renderOnce()
    check("CJK end recognized", bridge.cursorAtEnd())
    composer.moveCursorLeft()
    await setup.renderOnce()
    check("CJK interior not mistaken for end", !bridge.cursorAtEnd())

    for (const value of ["hello世界", "👩‍💻ok", "e\u0301x", "你好\n世界", "abc\n👋🏽z", "a\tb"]) {
      composer.replaceText("")
      composer.insertText(value)
      await setup.renderOnce()
      check(`${JSON.stringify(value)} end recognized`, bridge.cursorAtEnd())
      composer.moveCursorLeft()
      await setup.renderOnce()
      check(`${JSON.stringify(value)} left of end rejected`, !bridge.cursorAtEnd())
    }

    composer.destroy()
    promptFixture(renderer, nextComposer, identity)
    nextComposer.focus()
    check("rebuilt composer proven on focus", bridge.current() === nextComposer)
    runIntegrityPollOnce(bridge)
    nextComposer.insertText("hel")
    await setup.renderOnce()
    check("rebuilt composer becomes keymap target", suggestionTarget() === nextComposer)
    check("rebuilt composer accepts Tab", accept.run() !== false && nextComposer.plainText === "hello")
    check("former dialog left untouched", dialog.plainText === "hel")
  } finally {
    stopKeymap?.()
    bridge.dispose()
    await setup.dispose()
  }
}

async function migratedWrapperWithoutHostListener(): Promise<void> {
  const setup = await createTestRenderer({ width: 110, height: 10 })
  const { renderer } = setup
  const original = new TextareaRenderable(renderer, { id: "original", width: 100, height: 2 })
  const replacement = new TextareaRenderable(renderer, { id: "replacement", width: 100, height: 2 })
  const context = { renderer, ui: { router: { current: () => ({ type: "session", sessionID: "active" }) } } }
  const identity = createComposerIdentity(context)
  const bridge = createEditorBridge(context, identity)
  let notifications = 0
  let warningCount = 0
  const originalWarn = console.warn
  try {
    promptFixture(renderer, original, identity)
    original.focus()
    bridge.onInput(() => { notifications += 1 })
    bridge.onCaretMove(() => {})
    runIntegrityPollOnce(bridge)
    const migratedContent = original.onContentChange
    const migratedCursor = original.onCursorChange
    replacement.onContentChange = migratedContent
    replacement.onCursorChange = migratedCursor
    original.destroy()
    promptFixture(renderer, replacement, identity)
    replacement.focus()
    runIntegrityPollOnce(bridge)
    notifications = 0
    console.warn = () => { warningCount += 1 }
    replacement.insertText("hello")
    await setup.renderOnce()
    check("migrated empty-host wrappers do not recurse", warningCount === 0)
    check("migrated empty-host wrapper notifies once", notifications === 1)
    bridge.dispose()
    check("dispose leaves no orphan wrapper on adopted editor", replacement.onContentChange === undefined && replacement.onCursorChange === undefined)
    const newestHostListener = () => {}
    replacement.onContentChange = newestHostListener
    bridge.dispose()
    check("dispose never overwrites host's newer listener", replacement.onContentChange === newestHostListener)
  } finally {
    console.warn = originalWarn
    bridge.dispose()
    await setup.dispose()
  }
}

await realRendererScenarios()
await migratedWrapperWithoutHostListener()
console.log("----")
console.log(failures === 0 ? "测试结论：全部 PASS" : `测试结论：存在 FAIL（${failures} 处）`)
if (failures > 0) process.exitCode = 1
