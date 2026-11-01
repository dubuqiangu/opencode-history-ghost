import { BoxRenderable, TextareaRenderable } from "@opentui/core"
import { createTestRenderer } from "@opentui/core/testing"
import { createEditorBridge, runIntegrityPollOnce } from "../src/editor-bridge"
import { createComposerIdentity } from "../src/composer-identity"

let failures = 0
function check(label: string, condition: boolean): void {
  console.log(`${condition ? "PASS" : "FAIL"} ${label}`)
  if (!condition) failures++
}

const setup = await createTestRenderer({ width: 100, height: 20 })
const { renderer } = setup
let route = { type: "session", sessionID: "session-a" }
const context = { renderer, ui: { router: { current: () => route } } }
const identity = createComposerIdentity(context)
const bridge = createEditorBridge(context, identity)
let foreignFocusNotifications = 0
bridge.onForeignEditorFocus(() => { foreignFocusNotifications++ })
bridge.watch()
function mount(sessionID: string, withImage = false) {
  const root = new BoxRenderable(renderer, { id: `prompt-${sessionID}` })
  const border = new BoxRenderable(renderer, { id: `border-${sessionID}` })
  const padding = new BoxRenderable(renderer, { id: `padding-${sessionID}` })
  const footer = new BoxRenderable(renderer, { id: `footer-${sessionID}` })
  const marker = new BoxRenderable(renderer, { id: `marker-${sessionID}`, width: 0, height: 0 })
  const editor = new TextareaRenderable(renderer, { id: `textarea-${sessionID}`, width: 90, height: 2 })
  root.add(border); border.add(padding); padding.add(editor); root.add(footer); footer.add(marker)
  // OpenCode 2.0.29 Prompt always renders a metadata box immediately after
  // the textarea; image attachments can add further padding children.
  const metadata = new BoxRenderable(renderer, { id: `metadata-${sessionID}` })
  padding.add(metadata)
  if (withImage) padding.add(new BoxRenderable(renderer, { id: `image-${sessionID}` }))
  renderer.root.add(root)
  return { root, marker, editor, padding }
}
try {
  const dialog = new TextareaRenderable(renderer, { id: "dialog", width: 90, height: 2 })
  renderer.root.add(dialog)
  dialog.focus()
  bridge.onInput(() => {})
  runIntegrityPollOnce(bridge)
  check("first dialog cannot be adopted", bridge.current() === null && dialog.onContentChange === undefined)
  const first = mount("session-a")
  first.editor.focus()
  check("no marker fails closed", bridge.current() === null)
  const pendingMarker = new BoxRenderable(renderer, { id: "pending-footer-ref", width: 0, height: 0 })
  identity.register("session-a", pendingMarker)
  check("ref before parent connection fails closed", bridge.current() === null)
  first.marker.parent?.add(pendingMarker)
  check("asynchronously attached marker becomes valid", bridge.current() === first.editor)
  identity.unregister(pendingMarker)
  identity.register("session-a", first.marker)
  const unsupportedRouterIdentity = createComposerIdentity({ renderer, router: { current: () => route } })
  unsupportedRouterIdentity.register("session-a", first.marker)
  check("top-level router is not a supported identity source", unsupportedRouterIdentity.resolve() === null)
  unsupportedRouterIdentity.dispose()
  check("target verification has no listener side effects", bridge.current() === first.editor && first.editor.onContentChange === undefined)
  runIntegrityPollOnce(bridge)
  check("poll installs proven editor", typeof first.editor.onContentChange === "function")
  const notificationsBeforeBlur = foreignFocusNotifications
  first.editor.blur()
  check("blur to null clears exactly once on focus event", foreignFocusNotifications === notificationsBeforeBlur + 1 && bridge.current() === null)
  runIntegrityPollOnce(bridge)
  runIntegrityPollOnce(bridge)
  check("blurred poll does not repeatedly notify", foreignFocusNotifications === notificationsBeforeBlur + 1)
  first.editor.focus()
  dialog.focus()
  check("foreign focus clears synchronously", foreignFocusNotifications === notificationsBeforeBlur + 2)
  runIntegrityPollOnce(bridge)
  check("foreign poll does not repeatedly notify", foreignFocusNotifications === notificationsBeforeBlur + 2)
  first.editor.destroy()
  runIntegrityPollOnce(bridge)
  check("dialog after composer death refused", bridge.current() === null && dialog.onContentChange === undefined)
  const replacement = mount("session-a", true)
  identity.register("session-a", replacement.marker)
  dialog.focus()
  check("rebuild with dialog focus refused", bridge.current() === null)
  replacement.editor.focus()
  runIntegrityPollOnce(bridge)
  check("rebuild with proven focus admitted", bridge.current() === replacement.editor)
  route = { type: "session", sessionID: "session-b" }
  check("route change invalidates old slot", bridge.current() === null)
  const second = mount("session-b")
  identity.register("session-b", second.marker)
  second.editor.focus()
  check("new session marker admitted", bridge.current() === second.editor)
  const duplicate = mount("session-b")
  identity.register("session-b", duplicate.marker)
  check("multiple mounted prompts fail closed", bridge.current() === null)
  duplicate.root.destroy()
  check("destroyed old mount cannot veto live session", bridge.current() === second.editor)
  const secondTextarea = new TextareaRenderable(renderer, { id: "ambiguous-padding-textarea", width: 90, height: 2 })
  second.padding.add(secondTextarea)
  check("two direct padding textareas fail closed", bridge.current() === null)
  secondTextarea.destroy()
  check("destroyed extra textarea does not prevent proof", bridge.current() === second.editor)
  const foreignRoot = new BoxRenderable(renderer, { id: "permission" })
  const foreignTextarea = new TextareaRenderable(renderer, { id: "permission-input", width: 90, height: 2 })
  foreignRoot.add(foreignTextarea); renderer.root.add(foreignRoot)
  foreignTextarea.focus()
  check("permission textbox rejected", bridge.current() === null && bridge.acceptFullText("unsafe") === false)
  const formInput = new TextareaRenderable(renderer, { id: "form-input", width: 90, height: 2 })
  foreignRoot.add(formInput)
  formInput.focus()
  check("form textbox rejected", bridge.current() === null && bridge.acceptFullText("unsafe") === false)
} finally {
  bridge.dispose(); identity.dispose(); setup.renderer.destroy()
}
if (failures) process.exitCode = 1
