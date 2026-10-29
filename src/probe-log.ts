import * as fs from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { describeThrownValue } from "./thrown-dump"

// Probe path derives from this module's own location so the file lands in the
// plugin repo root no matter where it is installed (never a hardcoded user path).
const PROBE_PATH = join(dirname(fileURLToPath(import.meta.url)), "..", "probe-slot-errors.txt")
export function recordFailure(stage: string, thrown: unknown): void {
  try { fs.appendFileSync(PROBE_PATH, `${new Date().toISOString()} pid=${typeof process !== "undefined" ? process.pid : "?"} stage=${stage}\n${describeThrownValue(thrown)}\n---\n`) } catch {}
}
export function recordEvent(stage: string): void {
  try { fs.appendFileSync(PROBE_PATH, `${new Date().toISOString()} pid=${typeof process !== "undefined" ? process.pid : "?"} event=${stage}\n`) } catch {}
}