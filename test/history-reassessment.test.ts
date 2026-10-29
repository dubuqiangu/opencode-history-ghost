/** Synthetic history only: no user history, configuration, or history text is read or logged. */
import { mock, test } from "bun:test"
import type { HistoryEntry, HistorySourceWithDebug } from "../src/history-source"
import type { SuggestionStoreApi, HistoryGhostSettings } from "../src/suggestion-store"

const caretPrefix = "synthetic pre"
const initialCandidate = makeEntry("synthetic prefix original")
const refreshedCandidate = makeEntry("synthetic prefix replacement")
const changedCandidate = makeEntry("synthetic prefix changed again")

function makeEntry(text: string): HistoryEntry {
  return { text, lower: text.toLowerCase() }
}

function assertEqual<Value>(label: string, actual: Value, expected: Value): void {
  if (actual !== expected) {
    failures.push(`${label}: expected ${String(expected)}, got ${String(actual)}`)
    console.error(`FAIL: ${label}`)
  } else {
    console.log(`PASS: ${label}`)
  }
}

const failures: string[] = []
let resolveDatabaseLoad!: () => void
let databaseReady = new Promise<void>((resolve) => { resolveDatabaseLoad = resolve })
let historyEntries: HistoryEntry[] = []
let queuedRefreshEntries: HistoryEntry[] | undefined
let refreshCount = 0
let inputListener: (() => void) | undefined
let observedStore: SuggestionStoreApi | undefined
let ghostRefreshCount = 0
let caretPrefixReadCount = 0
let trustedCaretPrefix: string | null = caretPrefix

const syntheticHistorySource: HistorySourceWithDebug = {
  entries: () => historyEntries,
  refresh: () => {
    refreshCount += 1
    if (queuedRefreshEntries) {
      historyEntries = queuedRefreshEntries
      queuedRefreshEntries = undefined
    }
  },
  whenReady: () => databaseReady,
  readStats: () => ({ jsonlReads: 0, databaseLoads: 0 }),
}

mock.module(import.meta.resolve("../src/history-source"), () => ({
  createHistorySource: () => syntheticHistorySource,
}))
mock.module(import.meta.resolve("../src/editor-bridge"), () => ({
  createEditorBridge: () => ({
    caretPrefix: () => { caretPrefixReadCount += 1; return trustedCaretPrefix },
    onInput: (listener: () => void) => { inputListener = listener; return () => { inputListener = undefined } },
    onCaretMove: () => () => {},
    onForeignEditorFocus: () => () => {},
    watch: () => {},
    dispose: () => {},
  }),
}))
mock.module(import.meta.resolve("../src/ghost-line"), () => ({
  createGhostLine: ({ store }: { store: SuggestionStoreApi }) => {
    observedStore = store
    return { refresh: () => { ghostRefreshCount += 1 }, renderRow: () => null }
  },
}))

const { default: plugin } = await import("../src/tui")
const pluginContext = {
  renderer: { requestRender: () => {} },
  ui: { slot: () => () => {} },
}
let disposePlugin: (() => void) | undefined

test("history readiness and refresh re-assess an unchanged caret prefix without redundant repaint", async () => {
try {
  disposePlugin = plugin.setup(pluginContext) as () => void
  if (!observedStore || !inputListener) throw new Error("Synthetic TUI setup did not connect store and editor input")
  const store = observedStore
  inputListener()
  assertEqual("empty initial history has no suggestion", store.current()?.text ?? null, null)

  // DB loads after the user has already typed; there is deliberately no second input/caret event.
  historyEntries = [initialCandidate]
  resolveDatabaseLoad()
  await databaseReady
  await new Promise<void>((resolve) => setImmediate(resolve))
  assertEqual("DB readiness re-evaluates the existing caret prefix without typing", store.current()?.text ?? null, initialCandidate.text)

  // Keep later checks independent of the DB readiness failure: simulate the normal editor event.
  inputListener()
  assertEqual("fixture establishes a visible first suggestion", store.current()?.text ?? null, initialCandidate.text)
  const refreshesBeforeUnchangedInput = ghostRefreshCount
  const caretReadsBeforeUnchangedInput = caretPrefixReadCount
  inputListener()
  assertEqual("unchanged input and history do not repaint", ghostRefreshCount, refreshesBeforeUnchangedInput)
  assertEqual("repeated input reads caret only once", caretPrefixReadCount, caretReadsBeforeUnchangedInput + 1)

  // The existing source API has no change notification; its public refresh() is polled by TUI.
  queuedRefreshEntries = [refreshedCandidate]
  const refreshDeadline = Date.now() + 4500
  while (refreshCount === 0 && Date.now() < refreshDeadline) {
    await new Promise<void>((resolve) => setTimeout(resolve, 25))
  }
  assertEqual("TUI invokes the synthetic history source's refresh", refreshCount > 0, true)
  assertEqual("jsonl refresh replaces a visible candidate without typing", store.current()?.text ?? null, refreshedCandidate.text)
  const refreshesBeforeUnchangedHistory = ghostRefreshCount
  const caretReadsBeforeUnchangedHistory = caretPrefixReadCount
  const nextRefreshDeadline = Date.now() + 4500
  while (refreshCount < 2 && Date.now() < nextRefreshDeadline) {
    await new Promise<void>((resolve) => setTimeout(resolve, 25))
  }
  assertEqual("TUI performs a subsequent unchanged-history poll", refreshCount > 1, true)
  assertEqual("unchanged history does not repaint the ghost", ghostRefreshCount, refreshesBeforeUnchangedHistory)
  assertEqual("unchanged history does not read the caret", caretPrefixReadCount, caretReadsBeforeUnchangedHistory)

  // Exercise the store's public evaluate method independently of timer/wiring.
  let replacementEntries = [initialCandidate]
  const { createSuggestionStore } = await import("../src/suggestion-store")
  const settings: HistoryGhostSettings = {
    enabled: true, acceptKey: "tab", minChars: 3, maxCandidates: 10,
    maxEntries: 20, maxTextLength: 200, excludePrefixes: ["/", "@"],
  }
  const isolatedStore = createSuggestionStore(() => replacementEntries, settings)
  isolatedStore.evaluate(caretPrefix)
  assertEqual("store starts with synthetic first candidate", isolatedStore.current()?.text ?? null, initialCandidate.text)
  replacementEntries = [changedCandidate]
  isolatedStore.evaluate(caretPrefix)
  assertEqual("ordinary repeated input keeps its fast path", isolatedStore.current()?.text ?? null, initialCandidate.text)
  isolatedStore.reassess(caretPrefix)
  assertEqual("explicit history reassessment replaces the suggestion", isolatedStore.current()?.text ?? null, changedCandidate.text)
  const currentStateBeforeEquivalentHistory = isolatedStore.state()
  let redundantCommitCount = 0
  const stopCountingCommits = isolatedStore.onStateChange(() => { redundantCommitCount += 1 })
  replacementEntries = [makeEntry(changedCandidate.text)]
  isolatedStore.reassess(caretPrefix)
  assertEqual("same candidate text retains state", isolatedStore.state(), currentStateBeforeEquivalentHistory)
  assertEqual("same candidate text does not notify listeners", redundantCommitCount, 0)
  stopCountingCommits()
  isolatedStore.dismiss()
  replacementEntries = [refreshedCandidate]
  isolatedStore.reassess(caretPrefix)
  assertEqual("Esc still suppresses same input after history changes", isolatedStore.current()?.text ?? null, null)
  isolatedStore.evaluate(`${caretPrefix}f`)
  assertEqual("changing input re-arms the dismissed suggestion", isolatedStore.current()?.text ?? null, refreshedCandidate.text)

  if (failures.length > 0) {
    console.error(`${failures.length} history re-assessment assertion(s) failed`)
    throw new Error(`${failures.length} history re-assessment assertion(s) failed; see labeled failures above`)
  }
} finally {
  disposePlugin?.()
}
}, 12000)

test("disposed plugin ignores late DB readiness and timer does not read an untrusted editor", async () => {
  let resolvePendingDatabase!: () => void
  databaseReady = new Promise<void>((resolve) => { resolvePendingDatabase = resolve })
  historyEntries = []
  queuedRefreshEntries = undefined
  trustedCaretPrefix = null
  const disposedPlugin = plugin.setup(pluginContext) as () => void
  if (!observedStore || !inputListener) throw new Error("Synthetic TUI setup did not connect store and editor input")
  const store = observedStore
  inputListener()
  assertEqual("untrusted editor clears suggestion", store.current()?.text ?? null, null)
  const caretReadsBeforeDisposal = caretPrefixReadCount
  const ghostRefreshesBeforeDisposal = ghostRefreshCount
  disposedPlugin()
  historyEntries = [initialCandidate]
  resolvePendingDatabase()
  await databaseReady
  await new Promise<void>((resolve) => setImmediate(resolve))
  assertEqual("late DB completion does not read caret after dispose", caretPrefixReadCount, caretReadsBeforeDisposal)
  assertEqual("late DB completion does not repaint after dispose", ghostRefreshCount, ghostRefreshesBeforeDisposal)
  if (failures.length > 0) throw new Error(`${failures.length} history re-assessment assertion(s) failed`)
})

test("history readiness reads only the trusted caret and clears on unknown editor", async () => {
  let resolvePendingDatabase!: () => void
  databaseReady = new Promise<void>((resolve) => { resolvePendingDatabase = resolve })
  historyEntries = []
  trustedCaretPrefix = caretPrefix
  const disposeUnknownEditorScenario = plugin.setup(pluginContext) as () => void
  try {
    if (!observedStore || !inputListener) throw new Error("Synthetic TUI setup did not connect store and editor input")
    inputListener()
    trustedCaretPrefix = null
    const caretReadsBeforeReadiness = caretPrefixReadCount
    historyEntries = [initialCandidate]
    resolvePendingDatabase()
    await databaseReady
    await new Promise<void>((resolve) => setImmediate(resolve))
    assertEqual("history readiness checks trusted caret", caretPrefixReadCount, caretReadsBeforeReadiness + 1)
    assertEqual("unknown editor cannot receive history suggestion", observedStore.current()?.text ?? null, null)
    if (failures.length > 0) throw new Error(`${failures.length} history re-assessment assertion(s) failed`)
  } finally {
    disposeUnknownEditorScenario()
  }
})
