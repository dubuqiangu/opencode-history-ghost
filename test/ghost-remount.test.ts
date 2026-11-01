/** Real OpenTUI/Solid remount regression: stale native nodes must never be patched. */
import { testRender, render } from "@opentui/solid"
import { createGhostLine } from "../src/ghost-line"
import { createSuggestionStore, type HistoryGhostSettings } from "../src/suggestion-store"

const settings: HistoryGhostSettings = {
  enabled: true,
  acceptKey: "tab",
  minChars: 3,
  maxCandidates: 5,
  maxEntries: 2000,
  maxTextLength: 2000,
  excludePrefixes: ["/", "@"],
}
const history = [
  { text: "hello original candidate", lower: "hello original candidate" },
  { text: "world replacement candidate", lower: "world replacement candidate" },
]
const store = createSuggestionStore(() => history, settings)
store.evaluate("hel")
const ghost = createGhostLine({ store, settings, theme: undefined })
const setup = await testRender(() => ghost.renderRow(), { width: 110, height: 8 })
const { renderer } = setup

function assertFrameContains(label: string, expectedText: string): void {
  const frame = setup.captureCharFrame()
  if (!frame.includes(expectedText)) throw new Error(`${label}: expected ${JSON.stringify(expectedText)} in ${JSON.stringify(frame)}`)
  console.log(`PASS ${label}`)
}

function assertFrameCount(label: string, expectedText: string, expectedCount: number): void {
  const frame = setup.captureCharFrame()
  const actualCount = frame.split(expectedText).length - 1
  if (actualCount !== expectedCount) {
    throw new Error(`${label}: expected ${expectedCount} copies of ${JSON.stringify(expectedText)}, got ${actualCount} in ${JSON.stringify(frame)}`)
  }
  console.log(`PASS ${label}`)
}

try {
  await setup.renderOnce()
  assertFrameContains("initial suggestion mounted", "hello original candidate")

  const firstRow = renderer.root.getChildren()[0]
  await render(() => ghost.renderRow(), renderer)
  await setup.renderOnce()
  assertFrameCount("two concurrently mounted rows show current suggestion", "hello original candidate", 2)

  store.evaluate("wor")
  ghost.refresh()
  await setup.renderOnce()
  assertFrameCount("both live rows update together", "world replacement candidate", 2)

  const secondRow = renderer.root.getChildren()[1]
  secondRow.destroyRecursively()
  store.evaluate("hel")
  ghost.refresh()
  await setup.renderOnce()
  assertFrameCount("first row updates after second is destroyed", "hello original candidate", 1)

  firstRow.destroyRecursively()
  await render(() => ghost.renderRow(), renderer)
  await setup.renderOnce()
  assertFrameCount("new row mounts after both previous rows are destroyed", "hello original candidate", 1)

  for (let round = 0; round < 3; round += 1) {
    // The host discards its prior slot tree while keeping the same renderer.
    for (const oldRow of renderer.root.getChildren()) oldRow.destroyRecursively()

    // The old candidate is still active when the new row is mounted. In the
    // buggy controller its first ref writes into the previously destroyed row.
    ghost.refresh()
    await render(() => ghost.renderRow(), renderer)
    await setup.renderOnce()
    assertFrameContains(`remount ${round} retained active suggestion`, "hello original candidate")

    store.evaluate("wor")
    ghost.refresh()
    await setup.renderOnce()
    assertFrameContains(`remount ${round} updates latest row`, "world replacement candidate")

    store.evaluate("hel")
    ghost.refresh()
  }
} finally {
  setup.renderer.destroy()
}
