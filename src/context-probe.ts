// TEMPORARY diagnostic (not part of the plugin's behaviour).
//
// Dumps the runtime shape of the host's `setup()` context so the assembly layer
// can be pointed at the surface that actually exists in this host version,
// instead of guessing at `context.ui.slot` / `context.ui.keymap`.
import * as fs from "node:fs"
import * as nodePath from "node:path"

/** Absolute path of the shape dump — outside the bundle, for manual reading. */
const PROBE_FILE = nodePath.join(
  "D:\\workSpace\\python\\aicode\\opencode\\opencode-history-ghost",
  "probe-context-shape.txt",
)

function describeValue(value: unknown): string {
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  const valueType = typeof value;
  if (valueType === "object" || valueType === "function") {
    const own: string[] = [];
    const proto: string[] = [];
    try {
      for (const name of Object.keys(value as object).slice(0, 40)) own.push(name);
    } catch {}
    try {
      let cursor: object | null = Object.getPrototypeOf(value as object);
      let depth = 0;
      while (cursor && depth < 3 && cursor !== Object.prototype) {
        for (const name of Object.getOwnPropertyNames(cursor)) {
          if (name === "constructor") continue
          if (own.includes(name) || proto.includes(name)) continue
          proto.push(name)
        }
        cursor = Object.getPrototypeOf(cursor)
        depth += 1
      }
    } catch {}
    return `${valueType} own=[${own.join(",")}] proto=[${proto.join(",")}]`
  }
  return `${valueType}`
}

export function probeContextShape(context: unknown): void {
  const lines: string[] = []
  lines.push(`=== ${new Date().toISOString()} pid=${process.pid} ===`)
  try {
    const keys = Object.keys((context as object) ?? {})
    lines.push(`top-level keys: ${keys.join(",")}`)
    for (const key of keys) {
      let value: unknown
      try {
        value = (context as Record<string, unknown>)[key]
      } catch (error) {
        lines.push(`${key}: read threw ${String(error)}`)
        continue
      }
      lines.push(`${key}: ${describeValue(value)}`)
    }
    const ui = (context as { ui?: unknown } | undefined)?.ui
    if (ui) {
      lines.push(`ui: ${describeValue(ui)}`)
      for (const uiKey of Object.keys(ui as object)) {
        lines.push(`ui.${uiKey}: ${describeValue((ui as Record<string, unknown>)[uiKey])}`)
      }
    } else {
      lines.push("ui: ABSENT")
    }
  } catch (error) {
    lines.push(`probe failed: ${String(error)}`)
  }
  try {
    fs.appendFileSync(PROBE_FILE, lines.join("\n") + "\n")
  } catch {}
}
