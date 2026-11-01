// Editor access bridge for opencode-history-ghost (T5, DESIGN §3.3; defect-3/4 fix).
//
// Editor access requires an independently proven composer identity; the
// semi-official surface (see @opentui/core renderer.d.ts:418 and
// EditBufferRenderable.d.ts for plainText/cursorOffset/replaceText; the
// native edit-buffer.d.ts provides getTextRange/measureText). The
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
// TRUSTED-COMPOSER POLICY: focus and editor lifetime are NOT identity.
// The prompt.footer marker's structural proof is checked on every read and
// write; only the poll may install listener wrappers on a proven editor.

/** Structural subset of EditBufferRenderable that this plugin relies on. */
export interface EditBufferLike {
  /** Full editor content (code units, multi-line preserved). */
  readonly plainText: string
  /**
   * Display-cell caret offset on real OpenTUI textareas. Kept `readonly` here
   * because this plugin only ever READS it; the real object's setter is writable
   * (EditBufferRenderable.cursorOffset has a setter — the SDK's own
   * InputRenderable.value setter relies on it). acceptFullText deliberately
   * writes it via a local cast, never loosening this read-only surface.
   */
  readonly cursorOffset: number
  /**
   * Native buffer offsets are display cells (including line breaks).
   * `measureText(text)` returns the display-cell offset of the END of a string
   * (counting CJK/emoji/tab as their on-screen widths) — the same convention
   * cursorOffset uses, so acceptFullText reuses it to park the caret.
   */
  readonly editBuffer?: { measureText(text: string): number; getTextRange(start: number, end: number): string }
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
  /** Current trustworthy text and cursor prefix; null for ambiguous offsets. */
  caretSnapshot(): EditorSnapshot | null
  /** Current cursor prefix; never treats a display-cell offset as a JS index. */
  caretPrefix(): string | null
  /** Legacy end-of-input probe (new matching uses caretSnapshot). */
  cursorAtEnd(): boolean
  /** Replaces the input with the accepted suggestion text; false on failure. */
  acceptFullText(text: string): boolean
  /** Subscribes to composer input changes; the return value unsubscribes. */
  onInput(handler: (text: string) => void): () => void
  /**
   * Subscribes to caret moves; the handler receives whether the caret sits
   * at the end after the move. Consumers re-read the native cursor prefix
   * on every move (pure moves do not trigger content changes).
   */
  onCaretMove(handler: (caretAtEnd: boolean) => void): () => void
  /**
   * Receives a foreign editor or null when focus leaves all editors.
   */
  onForeignEditorFocus(handler: (foreignEditor: EditBufferLike | null) => void): () => void
  /** Starts the 1.5s focused-editor identity poll that keeps the hooks alive. */
  watch(): void
  /** Removes every hook, subscription, and timer. Idempotent. */
  dispose(): void
}

export interface EditorSnapshot {
  readonly editor: EditBufferLike
  readonly text: string
  readonly prefix: string
  readonly offset: number
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
  if (!Object.prototype.hasOwnProperty.call(slotRecord, installedWrapperSymbol)) return slotValue
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

export function createEditorBridge(context: unknown, identity: { resolve(): EditBufferLike | null }): EditorBridge {
  const inputHandlers = new Set<(text: string) => void>()
  const caretMoveHandlers = new Set<(caretAtEnd: boolean) => void>()
  const foreignEditorFocusHandlers = new Set<(foreignEditor: EditBufferLike | null) => void>()
  let wrappedEditor: EditBufferLike | null = null
  let originalOnContentChange: ((event: unknown) => void) | undefined
  let installedContentChangeWrapper: ((event: unknown) => void) | undefined
  let originalOnCursorChange: ((event: unknown) => void) | undefined
  let installedCursorChangeWrapper: ((event: unknown) => void) | undefined
  let identityPollTimer: ReturnType<typeof setInterval> | undefined
  let stopFocusListening: (() => void) | undefined
  // undefined means the last observed focus was trusted; null is a blur.
  let lastUntrustedFocus: EditBufferLike | null | undefined
  let disposed = false

  function snapshot(editor: EditBufferLike): EditorSnapshot | null {
    const text = editor.plainText
    const offset = editor.cursorOffset
    if (!Number.isSafeInteger(offset) || offset < 0) return null
    const buffer = editor.editBuffer
    if (buffer && typeof buffer.measureText === "function" && typeof buffer.getTextRange === "function") {
      const end = buffer.measureText(text)
      if (offset > end) return null
      const prefix = buffer.getTextRange(0, offset)
      const suffix = buffer.getTextRange(offset, end)
      // Native grapheme boundaries, tabs, CRLF and display-cell widths are
      // authoritative; reject inconsistent/native-mid-cell values outright.
      if (prefix + suffix !== text || buffer.measureText(prefix) !== offset) return null
      return { editor, text, prefix, offset }
    }
    // Fake/legacy buffers can prove only a JS-code-unit end, never an interior
    // display-cell mapping. Preserve their end-of-input behavior only.
    if (!buffer && offset === text.length) return { editor, text, prefix: text, offset }
    return null
  }

  /** SDK offsets are display cells, not UTF-16/code-point counts. Fake editors
   * without an SDK buffer retain their original code-unit convention. */
  function caretAtTextEnd(editor: EditBufferLike): boolean {
    const text = editor.plainText
    const measureText = editor.editBuffer?.measureText
    if (typeof measureText === "function") {
      return editor.cursorOffset >= measureText.call(editor.editBuffer, text)
    }
    return editor.cursorOffset >= text.length
  }

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
      caretAtEnd = caretAtTextEnd(editor)
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
      const capturedHostContentChange = originalOnContentChange
      installedContentChangeWrapper = (event: unknown) => {
        if (capturedHostContentChange) {
          try {
            capturedHostContentChange(event)
          } catch (error) {
            warnOnce("the host onContentChange listener failed:", error)
          }
        }
        if (capturedEditor.isDestroyed === true || wrappedEditor !== capturedEditor || identity.resolve() !== capturedEditor) return
        notifyInput(capturedEditor)
      }
      ;(installedContentChangeWrapper as PossiblyWrappedListener)[installedWrapperSymbol] =
        capturedHostContentChange
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
      const capturedHostCursorChange = originalOnCursorChange
      installedCursorChangeWrapper = (event: unknown) => {
        if (capturedHostCursorChange) {
          try {
            capturedHostCursorChange(event)
          } catch (error) {
            warnOnce("the host onCursorChange listener failed:", error)
          }
        }
        if (capturedEditor.isDestroyed === true || wrappedEditor !== capturedEditor || identity.resolve() !== capturedEditor) return
        notifyCaretMove(capturedEditor)
      }
      ;(installedCursorChangeWrapper as PossiblyWrappedListener)[installedWrapperSymbol] =
        capturedHostCursorChange
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

  /** One notification per untrusted transition; polling must not repeatedly
   * clear an already-cleared suggestion or disrupt a newly proven composer. */
  function notifyUntrustedFocus(foreignEditor: EditBufferLike | null): void {
    if (foreignEditor === lastUntrustedFocus) return
    lastUntrustedFocus = foreignEditor
    if (foreignEditorFocusHandlers.size === 0) return
    for (const foreignFocusHandler of foreignEditorFocusHandlers) {
      try {
        foreignFocusHandler(foreignEditor)
      } catch (error) {
        warnOnce("a foreign-editor-focus handler failed:", error)
      }
    }
  }

  /** Queries are read-only. Only the poll installs or repairs hooks. */
  function trustedFocusedEditor(): EditBufferLike | null {
    if (disposed) return null
    return identity.resolve()
  }

  /**
   * One identity-poll pass. watch()'s 1.5s interval and the TEST-ONLY
   * runIntegrityPollOnce() entry both run exactly this body (structural
   * extraction only — semantics identical to the former inline callback).
   */
  function runIdentityPoll(): void {
    try {
      const editor = identity.resolve()
      if (editor) lastUntrustedFocus = undefined
      else notifyUntrustedFocus(focusedEditor(context))
      if (wrappedEditor && (wrappedEditor.isDestroyed || (editor && wrappedEditor !== editor))) detachEditorHooks()
      if (editor && editor === wrappedEditor) {
        // Same instance — also detect the host having re-assigned either
        // listener slot on it; re-chain onto the newest listeners then.
        if (editorHooksStillInstalled(editor)) return
        installEditorHooks(editor)
        return
      }
      if (editor) {
       // A proven editor, never a guessed replacement.
        installEditorHooks(editor)
        notifyInput(editor)
        return
      }
      // Nothing focused: only drop the hooks if the wrapped editor died,
      // so a temporary blur (sidebar focus etc.) does not cause a
      // needless detach/re-attach cycle.
      if (wrappedEditor?.isDestroyed === true) detachEditorHooks()
    } catch (error) {
      warnOnce("editor identity poll failed:", error)
    }
  }

  const bridge: EditorBridge = {
    current(): EditBufferLike | null {
      return trustedFocusedEditor()
    },
    inputText(): string | null {
      const editor = trustedFocusedEditor()
      if (!editor) return null
      try {
        return editor.plainText
      } catch (error) {
        warnOnce("failed to read the editor text:", error)
        return null
      }
    },
    caretSnapshot(): EditorSnapshot | null {
      const editor = trustedFocusedEditor()
      if (!editor) return null
      try {
        return snapshot(editor)
      } catch (error) {
        warnOnce("failed to read the caret prefix:", error)
        return null
      }
    },
    caretPrefix(): string | null {
      return bridge.caretSnapshot()?.prefix ?? null
    },
    cursorAtEnd(): boolean {
      const editor = trustedFocusedEditor()
      if (!editor) return false
      try {
        return caretAtTextEnd(editor)
      } catch (error) {
        warnOnce("failed to read the caret position:", error)
        return false
      }
    },
    acceptFullText(text: string): boolean {
      const editor = trustedFocusedEditor()
      if (!editor) return false
      try {
        editor.replaceText(text)
        // replaceText preserves undo but does NOT move the caret; the native
        // buffer leaves it wherever it last was (front). Position it at the end
        // of the accepted text in DISPLAY CELLS — the SDK's offset convention
        // (the SDK's own InputRenderable.value setter does the same via
        // editBuffer.getEOL().offset; we reuse measureText which is its sibling).
        const buffer = editor.editBuffer
        if (buffer && typeof buffer.measureText === "function") {
          const editableCursor = editor as EditBufferLike & { cursorOffset: number }
          if (typeof editableCursor.cursorOffset === "number") {
            editableCursor.cursorOffset = buffer.measureText(text)
          }
        }
        return true
      } catch (error) {
        warnOnce("failed to write the accepted suggestion into the editor:", error)
        return false
      }
    },
    onInput(inputHandler: (text: string) => void): () => void {
      inputHandlers.add(inputHandler)
      return () => {
        inputHandlers.delete(inputHandler)
      }
    },
    onCaretMove(caretMoveHandler: (caretAtEnd: boolean) => void): () => void {
      caretMoveHandlers.add(caretMoveHandler)
      return () => {
        caretMoveHandlers.delete(caretMoveHandler)
      }
    },
    onForeignEditorFocus(foreignFocusHandler: (foreignEditor: EditBufferLike | null) => void): () => void {
      foreignEditorFocusHandlers.add(foreignFocusHandler)
      return () => {
        foreignEditorFocusHandlers.delete(foreignFocusHandler)
      }
    },
    watch(): void {
      if (identityPollTimer !== undefined || disposed) return
      // OpenTUI emits a focused-editor change synchronously. Clear stale
      // suggestions at focus time, not after the 1.5s repair interval.
      try {
        const renderer = (context as { renderer?: {
          on?: (event: string, handler: () => void) => void
          off?: (event: string, handler: () => void) => void
        } })?.renderer
        if (renderer?.on && renderer?.off) {
          const onFocusChange = () => {
            const focused = focusedEditor(context)
            if (identity.resolve() === focused && focused) lastUntrustedFocus = undefined
            else notifyUntrustedFocus(focused)
          }
          renderer.on("focused_editor", onFocusChange)
          stopFocusListening = () => renderer.off?.("focused_editor", onFocusChange)
        }
      } catch (error) {
        warnOnce("failed to subscribe to editor focus changes:", error)
      }
      identityPollTimer = setInterval(runIdentityPoll, 1500)
    },
    dispose(): void {
      if (disposed) return
      disposed = true
      stopFocusListening?.()
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
