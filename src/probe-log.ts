import * as fs from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { describeThrownValue } from "./thrown-dump"

// Probe paths derive from this module's own location so the files land in the
// plugin repo root no matter where it is installed (never a hardcoded user path).
const PROBE_DIRECTORY = join(dirname(fileURLToPath(import.meta.url)), "..")
const PROBE_PATH = join(PROBE_DIRECTORY, "probe-slot-errors.txt")

export function recordFailure(stage: string, thrown: unknown): void {
  try { fs.appendFileSync(PROBE_PATH, `${new Date().toISOString()} pid=${typeof process !== "undefined" ? process.pid : "?"} stage=${stage}\n${describeThrownValue(thrown)}\n---\n`) } catch {}
}