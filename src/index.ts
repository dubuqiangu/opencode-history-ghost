// opencode-history-ghost single entry point.
//
// The host resolves exactly one entry per plugin (`package.json` export "."),
// and that entry is what actually runs. An earlier layout exposed the TUI
// plugin only through the "./tui" subpath export and kept this "." entry as an
// empty stub — the host never read "./tui", so the TUI code below never
// executed. The TUI plugin definition is therefore re-exported here as the
// default export, making it the real entry while staying importable by tests.
export { default } from "./tui"
