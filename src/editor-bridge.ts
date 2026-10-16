// Editor access bridge for opencode-history-ghost (T5, DESIGN §3.3; defect-3/4 fix).
//
// Every editor access goes through renderer.currentFocusedEditor — a
// semi-official surface (see @opentui/core renderer.d.ts:418 and
// EditBufferRenderable.d.ts for plainText/cursorOffset/replaceText). The
// whole module is defensive by contract: optional chaining at every step,
// isDestroyed checks before each editor operation, warn-once error
// swallowing — a broken host integration must never crash the TUI.
//
// Content AND caret changes are observed by wrapping the editor's
// onContentChange / onCursorChange accessor pairs (their real signatures
// are (event) => void — the events carry no text, so the wrappers read
// plainText/cursorOffset themselves). The host rebuilds the composer
// textarea when switching sessions/modes AND can re-assign either listener
// slot on the very same instance, silently dropping our wrapper. Both death
// modes are covered:
//   - instance change: the 1.5s identity poll re-mounts the wrappers;
//   - same-instance overwrite: the poll also verifies each installed wrapper
//     is still the slot's current value (editor.onContentChange ===
//     installedContentChangeWrapper), and re-chains onto the host's newest
//     listener otherwise — the stale saved original is dropped, never
//     restored over the host's fresher assignment. Failure window <= 1.5s.
//
// TRUSTED-COMPOSER POLICY (defect-2 fix): OpenCode's dialogs (rename, prompt,
// ...) and the sidebar search also use EditBuffer renderables, so blindly
// following focus would let the plugin hijack their typing. The host only
// ever swaps the composer textarea through destroy-then-rebuild (verified
// behavior on session/mode switches), while a dialog input takes focus with
// the composer instance still ALIVE. This distinguishes both cases with zero
// host-internal guessing:
//   - focus moved to a different editor while our wrapped instance is still
//     alive → foreign surface: never wrap it, notify onForeignEditorFocus
//     (no ghost line, no Tab/Esc interference there);
//   - the wrapped instance died → the new focused editor is the rebuilt
//     composer: adopt it.
// The keymap commands additionally re-verify editor text consistency at
// run() time (see keymap.ts), which closes the <= 1.5s poll race window.

/** Structural subset of EditBufferRenderable that this plugin relies on. */
export interface EditBufferLike {
  /** Full editor content (code units, multi-line preserved). */
  readonly plainText: string
  /** Absolute caret position in code units. */
  readonly cursorOffset: number
  /** Replaces the whole buffer content while preserving undo history. */
  replaceText(text: string): void
  /** True once the renderable has been destroyed by the host. */
  readonly isDestroyed: boolean
  /** Host content-change listener slot we wrap (getter/setter pair at runtime). */
  onContentChange: ((event: unknown) => void) | undefined
  /** Host caret-change listener slot we wrap (getter/setter pair at runtime). */
  onCursorChange: ((event: unknown) => void) | undefined
}

export interface EditorBridge {
  /** The focused editor when it is the composer textarea; null otherwise. */
  current(): EditBufferLike | null
  /** Reads the current input text; null when no live editor. */
  inputText(): string | null
  /** True when the caret sits at the very end of the input. */
  cursorAtEnd(): boolean
  /** Replaces the input with the accepted suggestion text; false on failure. */
  acceptFullText(text: string): boolean
  /** Subscribes to composer input changes; the return value unsubscribes. */
  onInput(handler: (text: string) => void): () => void
  /**
   * Subscribes to caret moves; the handler receives whether the caret sits
   * at the end of the input after the move. Used to collapse suggestions the
   * moment the caret leaves the end (DESIGN §4), which typing alone cannot
   * detect.
   */
  onCaretMove(handler: (caretAtEnd: boolean) => void): () => void
  /**
   * Subscribes to focus landing on an editor OTHER than the wrapped one
   * while the wrapped instance is still alive — dialog inputs, sidebar
   * search, any foreign EditBuffer surface. The handler receives that
   * editor. Consumers collapse their UI here so nothing lingers during
   * dialogs (defect-2 fix).
   */
  onForeignEditorFocus(handler: (foreignEditor: EditBufferLike) => void): () => void
  /** Starts the 1.5s focused-editor identity poll that keeps the hooks alive. */
  watch(): void
  /** Removes every hook, subscription, and timer. Idempotent. */
  dispose(): void
}

/**
 * TEST-ONLY manual poll trigger (D8 contract stays 9 methods — this is a
 * module-level exposure, not a bridge method). Unit tests drive the
 * self-heal path deterministically through the exact body the watch()
 * interval runs, instead of waiting on a real 1.5s timer. No product code
 * path calls this; adding it changes zero runtime behavior.
 */
const integrityPollBodies = new WeakMap<EditorBridge, () => void>()

/** TEST-ONLY: runs one identity-poll pass for the given bridge (no-op for an unknown/disposed bridge). */
export function runIntegrityPollOnce(bridge: EditorBridge): void {
  const pollBody = integrityPollBodies.get(bridge)
  if (pollBody) pollBody()
}

const LOG_PREFIX = "[opencode-history-ghost]"
/** Warn-once registry: repeated identical failures stay silent after the first. */
const warnedMessages = new Set<string>()

/**
 * Module-level marker stamped on every listener wrapper we install. If the
 * host migrates one of our wrappers to a fresh editor instance (or a new
 * install cycle sees a slot still holding an older wrapper), the marker lets
 * installEditorHooks unwrap the slot to the true host listener instead of
 * chaining wrapper-on-wrapper — guaranteeing at most one wrapper layer on any
 * path. Symbol.for (not Symbol) so two copies of this module in one process
 * still recognize each other's wrappers.
 */
const installedWrapperSymbol = Symbol.for("opencode-history-ghost.installed-wrapper")

/** A listener slot value that may (or may not) be one of our wrappers. */
type PossiblyWrappedListener = ((event: unknown) => void) & {
  [installedWrapperSymbol]?: ((event: unknown) => void) | undefined
}

/**
 * Unwraps a slot value that is one of OUR wrappers to the host listener it
 * chains onto; any other value (host listener, undefined) is returned as-is.
 */
function unwrapInstalledWrapper(
  slotValue: ((event: unknown) => void) | undefined,
): ((event: unknown) => void) | undefined {
  if (typeof slotValue !== "function") return slotValue
  const slotRecord = slotValue as PossiblyWrappedListener
  if (slotRecord[installedWrapperSymbol] === undefined) return slotValue
  return slotRecord[installedWrapperSymbol]
}

function warnOnce(message: string, error: unknown): void {
  if (warnedMessages.has(message)) return
  warnedMessages.add(message)
  console.warn(`${LOG_PREFIX} ${message}`, error)
}

/** Reads the focused editor; never throws, returns null when unusable. */
function focusedEditor(context: unknown): EditBufferLike | null {
  try {
    const renderer = (context as { renderer?: Pick<import("@opentui/core").CliRenderer, "currentFocusedEditor"> } | undefined)?.renderer
    const editor = renderer?.currentFocusedEditor as EditBufferLike | null | undefined
    if (!editor || (editor as { isDestroyed?: boolean }).isDestroyed === true) return null
    return editor
  } catch (error) {
    warnOnce("failed to read the focused editor:", error)
    return null
  }
}

export function createEditorBridge(context: unknown): EditorBridge {
  const inputHandlers = new Set<(text: string) => void>()
  const caretMoveHandlers = new Set<(caretAtEnd: boolean) => void>()
  const foreignEditorFocusHandlers = new Set<(foreignEditor: EditBufferLike) => void>()
  let wrappedEditor: EditBufferLike | null = null
  let originalOnContentChange: ((event: unknown) => void) | undefined
  let installedContentChangeWrapper: ((event: unknown) => void) | undefined
  let originalOnCursorChange: ((event: unknown) => void) | undefined
  let installedCursorChangeWrapper: ((event: unknown) => void) | undefined
  let identityPollTimer: ReturnType<typeof setInterval> | undefined
  let disposed = false

  /** Fan-out of the latest editor text to every subscriber, each guarded. */
  function notifyInput(editor: EditBufferLike): void {
    if (inputHandlers.size === 0) return
    let editorText: string
    try {
      editorText = editor.plainText
    } catch (error) {
      warnOnce("failed to read the editor text:", error)
      return
    }
    for (const inputHandler of inputHandlers) {
      try {
        inputHandler(editorText)
      } catch (error) {
        warnOnce("an input handler failed:", error)
      }
    }
  }

  /** Fan-out of the post-move caret position, each subscriber guarded. */
  function notifyCaretMove(editor: EditBufferLike): void {
    if (caretMoveHandlers.size === 0) return
    let caretAtEnd: boolean
    try {
      caretAtEnd = editor.cursorOffset >= editor.plainText.length
    } catch (error) {
      warnOnce("failed to read the caret position:", error)
      return
    }
    for (const caretMoveHandler of caretMoveHandlers) {
      try {
        caretMoveHandler(caretAtEnd)
      } catch (error) {
        warnOnce("a caret-move handler failed:", error)
      }
    }
  }

  /**
   * True while both listener slots on this editor still hold OUR wrappers —
   * false the moment the host re-assigned either slot on the same instance.
   */
  function editorHooksStillInstalled(editor: EditBufferLike): boolean {
    return (
      installedContentChangeWrapper !== undefined &&
      installedCursorChangeWrapper !== undefined &&
      editor.onContentChange === installedContentChangeWrapper &&
      editor.onCursorChange === installedCursorChangeWrapper
    )
  }

  /**
   * Installs both wrappers on the given editor. Per-hook idempotence: a slot
   * that still holds our wrapper is left untouched; an overwritten slot
   * chains onto the host's CURRENT listener (adopted as the new original),
   * so nothing the host registered is ever dropped. A slot whose current
   * value is one of OUR (possibly host-migrated) wrappers is unwrapped first
   * via installedWrapperSymbol, so a wrapper is never chained onto another
   * wrapper. A brand-new editor first gets whatever we still own restored
   * on the previous one.
   */
  function installEditorHooks(editor: EditBufferLike): void {
    if (wrappedEditor === editor && editorHooksStillInstalled(editor)) return
    if (wrappedEditor !== editor) {
      detachEditorHooks()
    }
    const capturedEditor = editor
    if (installedContentChangeWrapper === undefined || editor.onContentChange !== installedContentChangeWrapper) {
      // Self-reference guard: if the slot still holds one of OUR wrappers
      // (migrated by the host, or left by an earlier install cycle), unwrap
      // it and chain onto the true host listener — never wrapper-on-wrapper.
      originalOnContentChange = unwrapInstalledWrapper(editor.onContentChange)
      installedContentChangeWrapper = (event: unknown) => {
        if (originalOnContentChange) {
          try {
            originalOnContentChange(event)
          } catch (error) {
            warnOnce("the host onContentChange listener failed:", error)
          }
        }
        if ((capturedEditor as { isDestroyed?: boolean }).isDestroyed === true) return
        notifyInput(capturedEditor)
      }
      ;(installedContentChangeWrapper as PossiblyWrappedListener)[installedWrapperSymbol] =
        originalOnContentChange
      try {
        editor.onContentChange = installedContentChangeWrapper
      } catch (error) {
        warnOnce("failed to hook editor content changes:", error)
        installedContentChangeWrapper = undefined
        originalOnContentChange = undefined
      }
    }
    if (installedCursorChangeWrapper === undefined || editor.onCursorChange !== installedCursorChangeWrapper) {
      // Self-reference guard: same unwrap-before-chain rule as the content
      // slot above.
      originalOnCursorChange = unwrapInstalledWrapper(editor.onCursorChange)
      installedCursorChangeWrapper = (event: unknown) => {
        if (originalOnCursorChange) {
          try {
            originalOnCursorChange(event)
          } catch (error) {
            warnOnce("the host onCursorChange listener failed:", error)
          }
        }
        if ((capturedEditor as { isDestroyed?: boolean }).isDestroyed === true) return
        notifyCaretMove(capturedEditor)
      }
      ;(installedCursorChangeWrapper as PossiblyWrappedListener)[installedWrapperSymbol] =
        originalOnCursorChange
      try {
        editor.onCursorChange = installedCursorChangeWrapper
      } catch (error) {
        warnOnce("failed to hook editor caret changes:", error)
        installedCursorChangeWrapper = undefined
        originalOnCursorChange = undefined
      }
    }
    wrappedEditor = editor
  }

  /** Restores the original listeners on the wrapped editor, best-effort. */
  function detachEditorHooks(): void {
    const editor = wrappedEditor
    if (!editor) return
    wrappedEditor = null
    try {
      // Only restore a slot we still own; if the host overwrote it, its
      // newer listener stays in place untouched.
      if (installedContentChangeWrapper !== undefined && editor.onContentChange === installedContentChangeWrapper) {
        editor.onContentChange = originalOnContentChange
      }
    } catch (error) {
      warnOnce("failed to restore the original onContentChange listener:", error)
    }
    try {
      if (installedCursorChangeWrapper !== undefined && editor.onCursorChange === installedCursorChangeWrapper) {
        editor.onCursorChange = originalOnCursorChange
      }
    } catch (error) {
      warnOnce("failed to restore the original onCursorChange listener:", error)
    }
    originalOnContentChange = undefined
    installedContentChangeWrapper = undefined
    originalOnCursorChange = undefined
    installedCursorChangeWrapper = undefined
  }

  /** Fan-out of foreign-surface focus events, each subscriber guarded. */
  function notifyForeignEditorFocus(foreignEditor: EditBufferLike): void {
    if (foreignEditorFocusHandlers.size === 0) return
    for (const foreignFocusHandler of foreignEditorFocusHandlers) {
      try {
        foreignFocusHandler(foreignEditor)
      } catch (error) {
        warnOnce("a foreign-editor-focus handler failed:", error)
      }
    }
  }

  /**
   * Installs the hooks on the given editor ONLY when it is a legitimate
   * composer target (defect-2 fix, see the trust policy in the header):
   *   - the wrapped instance is still alive and a DIFFERENT editor took the
   *     focus → a dialog/sidebar input: never wrap it, notify and bail;
   *   - nothing wrapped yet (first run) or the wrapped instance died (host
   *     rebuilt the composer textarea) → adopt the focused editor.
   */
  function attachEditorIfTrusted(editor: EditBufferLike): void {
    if (wrappedEditor && editor !== wrappedEditor && wrappedEditor.isDestroyed === false) {
      notifyForeignEditorFocus(editor)
      return
    }
    installEditorHooks(editor)
  }

  /**
   * One identity-poll pass. watch()'s 1.5s interval and the TEST-ONLY
   * runIntegrityPollOnce() entry both run exactly this body (structural
   * extraction only — semantics identical to the former inline callback).
   */
  function runIdentityPoll(): void {
    try {
      const editor = focusedEditor(context)
      if (editor && editor === wrappedEditor) {
        // Same instance — also detect the host having re-assigned either
        // listener slot on it; re-chain onto the newest listeners then.
        if (editorHooksStillInstalled(editor)) return
        installEditorHooks(editor)
        return
      }
      if (editor) {
        // Different editor took the focus. Trusted adoption decides:
        // a live wrapped composer means this is a dialog/sidebar input
        // (notify, never wrap); a dead wrapped instance means the host
        // rebuilt the composer textarea (adopt the new one).
        attachEditorIfTrusted(editor)
        return
      }
      // Nothing focused: only drop the hooks if the wrapped editor died,
      // so a temporary blur (sidebar focus etc.) does not cause a
      // needless detach/re-attach cycle.
      if ((wrappedEditor as { isDestroyed?: boolean } | null)?.isDestroyed === true) {
        detachEditorHooks()
      }
    } catch (error) {
      warnOnce("editor identity poll failed:", error)
    }
  }

  const bridge: EditorBridge = {
    current(): EditBufferLike | null {
      return focusedEditor(context)
    },
    inputText(): string | null {
      const editor = focusedEditor(context)
      if (!editor) return null
      try {
        return editor.plainText
      } catch (error) {
        warnOnce("failed to read the editor text:", error)
        return null
      }
    },
    cursorAtEnd(): boolean {
      const editor = focusedEditor(context)
      if (!editor) return false
      try {
        return editor.cursorOffset >= editor.plainText.length
      } catch (error) {
        warnOnce("failed to read the caret position:", error)
        return false
      }
    },
    acceptFullText(text: string): boolean {
      const editor = focusedEditor(context)
      if (!editor) return false
      try {
        editor.replaceText(text)
        return true
      } catch (error) {
        warnOnce("failed to write the accepted suggestion into the editor:", error)
        return false
      }
    },
    onInput(inputHandler: (text: string) => void): () => void {
      inputHandlers.add(inputHandler)
      // Hook lazily on first subscription so an unused bridge never touches
      // host state. Trusted adoption only: a dialog input focused at this
      // moment is still refused (see attachEditorIfTrusted).
      const editor = focusedEditor(context)
      if (editor) attachEditorIfTrusted(editor)
      return () => {
        inputHandlers.delete(inputHandler)
      }
    },
    onCaretMove(caretMoveHandler: (caretAtEnd: boolean) => void): () => void {
      caretMoveHandlers.add(caretMoveHandler)
      const editor = focusedEditor(context)
      if (editor) attachEditorIfTrusted(editor)
      return () => {
        caretMoveHandlers.delete(caretMoveHandler)
      }
    },
    onForeignEditorFocus(foreignFocusHandler: (foreignEditor: EditBufferLike) => void): () => void {
      foreignEditorFocusHandlers.add(foreignFocusHandler)
      return () => {
        foreignEditorFocusHandlers.delete(foreignFocusHandler)
      }
    },
    watch(): void {
      if (identityPollTimer !== undefined || disposed) return
      identityPollTimer = setInterval(runIdentityPoll, 1500)
    },
    dispose(): void {
      if (disposed) return
      disposed = true
      if (identityPollTimer !== undefined) {
        clearInterval(identityPollTimer)
        identityPollTimer = undefined
      }
      detachEditorHooks()
      inputHandlers.clear()
      caretMoveHandlers.clear()
      foreignEditorFocusHandlers.clear()
    },
  }
  // TEST-ONLY exposure registry (see runIntegrityPollOnce above).
  integrityPollBodies.set(bridge, runIdentityPoll)
  return bridge
}
