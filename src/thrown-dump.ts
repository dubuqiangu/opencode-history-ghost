// Diagnostic: dump any thrown value with name/message/stack so it can be
// identified instead of only its string form.
export function describeThrownValue(thrown: unknown): string {
  const lines: string[] = []
  lines.push(`typeof=${typeof thrown}`)
  try {
    lines.push(`String()=${String(thrown)}`)
  } catch (error) {
    lines.push(`String() threw ${String(error)}`)
  }
  if (thrown && typeof thrown === "object") {
    const candidate = thrown as { name?: unknown; message?: unknown; stack?: unknown; code?: unknown }
    lines.push(`name=${String(candidate.name)}`)
    lines.push(`message=${String(candidate.message)}`)
    lines.push(`code=${String(candidate.code)}`)
    lines.push(`stack=${String(candidate.stack)}`)
    try {
      lines.push(`ownKeys=${Object.keys(thrown).join(",")}`)
    } catch {}
  }
  return lines.join("\n")
}
