import { expect, test } from "bun:test"
import { fileURLToPath } from "node:url"
import { Host } from "@opencode/plugin/host"

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url))

test("directory-based host discovery loads both history-ghost entrypoints", async () => {
  const entrypoints = Host.resolve({ directory: repositoryRoot })

  expect(entrypoints.server).toBeDefined()
  expect(entrypoints.tui).toBeDefined()

  for (const entrypoint of [entrypoints.server!, entrypoints.tui!]) {
    const pluginModule = await Host.load(entrypoint)
    expect(pluginModule.default?.id).toBe("history-ghost")
    expect(typeof pluginModule.default?.setup).toBe("function")
  }
})
