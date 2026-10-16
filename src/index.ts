// opencode-history-ghost server-side entry.
//
// This is a pure TUI plugin: every user-visible feature lives in ./tui.tsx,
// which OpenCode loads through the "@opencode/plugin" TUI runtime via the
// package.json export "./tui". The host still requires the "." entry point
// to expose a default definition with an id and a setup function — an empty
// module makes the server-side loader record the plugin as broken
// (`plugin list` shows "- -"). Plain default export object, mirroring the
// proven pattern in sibling plugins: no hooks registered, setup is a no-op.
export default {
  id: "history-ghost",
  setup() {},
}
