# opencode-history-ghost 设计文档

## 0. 一句话

用户在 OpenCode V2 TUI 输入框打字时，基于历史输入做分层匹配（前缀 > 子串 > fuzzy），
把最匹配的一条以"幽灵行"显示在输入框正上方（已输入部分正常色 + 建议后缀灰显），
Tab 接受即用整句替换当前输入；候选可循环，功能可开关，匹配为纯内存亚毫秒级。

## 1. 调研结论（决策依据，详细报告见会话记录）

| 来源 | 结论 | 本设计采纳 |
|---|---|---|
| tleclaire/opencode-autocomplete（V1，无 LICENSE） | 功能几乎一致但 V1 API + 无许可证，不可复用代码 | 借鉴：DB 路径解析、预计算小写副本、README 坑清单 |
| Hermes（prompt_toolkit） | 纯前缀最新优先，每键后台协程单飞，O(n) 内存扫描够快 | 采纳：内存扫描 + 最新优先；不需要 Trie |
| fish shell | 增量应用防闪烁；Tab 让位补全弹窗；后台防抖 | 采纳：增量应用 + Tab mode 隔离 |
| 官方 issue #5558 | OpenCode 无插件贡献补全项的钩子；内置补全用 fuzzysort | fuzzy 档直接用 fuzzysort（MIT，宿主同款） |
| opencode 源码实证（exp-2） | currentFocusedEditor 可读写输入框；keymap 可绑 Tab 且与 autocomplete mode 天然互斥；session.composer.top slot 可挂幽灵行；~/.local/state/opencode/prompt-history.jsonl（50 条）+ opencode.db（全量用户消息） | 全部采纳 |

**明确不做**：打字后把灰字真插进输入框 buffer（原生不支持，extmark 方案污染提交/撤销语义，
上游 #2207 有事故记录）。视觉内联是唯一的硬限制，用输入框正上方幽灵行替代。

**反应式决策（defect-1）**：插件侧 node_modules 携带 solid-js / @opentui/solid 的影子副本，
宿主（v2.0.29）只对预编译单文件 bundle 的 hoisted import 稳定替换自有模块实例
（usage-meter 坑 #13/#16）；插件侧 createSignal/createMemo 落在影子模块图上，其渲染
副作用不进宿主 slot 机制，界面冻结在挂载时快照。因此本插件**全链不用任何 Solid 原语**：
状态是普通对象 + 显式 onStateChange 监听集，UI 用静态 JSX + ref 捕获渲染实例 +
命令式 patch + renderer.requestRender()。

## 2. 架构与数据流

```
按键 → TextareaRenderable.onContentChange（插件包装层，同进程同步，零 IPC）
     → suggestion-store.evaluate(plainText)
         ├─ 第 0 层 trim-once 归一：raw editor text 在入口 trim 一次，
         │   state.input、增量快路径比较、高亮切片全用 trim 后值
         ├─ dismiss 恢复（Esc 只压制被取消的那一个输入；输入变化立即 re-arm）
         ├─ 防御过滤（开关关 / 空 / 短于 minChars / excludePrefixes @ 或 /）
         ├─ 增量快路径（新输入仍是当前建议前缀 → 只前移 input，不重算，防闪烁）
         └─ matcher.findCandidates()：前缀桶 > 子串桶 > fuzzysort 桶，档内最新优先
     → ghost-line（session.composer.top slot：静态 JSX + ref 捕获渲染实例；
       store.onStateChange 触发命令式 patch content/visible + renderer.requestRender()）

Tab → keymap layer（独立 append:"app" slot 内注册；mode:"global"，
      enabled: 有建议 && 开关开 && 补全弹窗未激活 && run 级一致性校验通过）
      → editor.replaceText(候选整句)  → suggestion-store.clear()

历史数据源（只读）：
  opencode.db（SQLite 只读打开；查询 LIMIT maxEntries 参数绑定，只物化最新 N 行，
  新到旧；启动加载一次，不重查）
  + prompt-history.jsonl（mtime 轮询 3s，增量合并，弥补"本次会话刚提交的 prompt 尚未入库"）
```

## 3. 模块划分与接口契约

```
opencode-history-ghost/
├── src/
│   ├── index.ts            # 服务端入口占位（纯 TUI 插件，export {}）
│   ├── tui.tsx             # 装配：Plugin.define + slot + cleanup（不做业务逻辑）
│   ├── history-source.ts   # 数据源：SQLite + jsonl 加载/归一/去重/增量刷新
│   ├── matcher.ts          # 纯函数匹配引擎
│   ├── editor-bridge.ts    # currentFocusedEditor 访问 / 双槽包装 / 自愈轮询 / 接受
│   ├── suggestion-store.ts # 命令式状态（候选列表、循环索引、开关）+ onStateChange 监听集
│   ├── ghost-line.tsx      # 幽灵行 UI 控制器（静态 JSX + ref + 命令式 patch）
│   └── keymap.ts           # keymap layer：accept/cycle/dismiss/toggle（返回 cleanup）
├── scripts/dev-smoke.ts    # 开发冒烟：对本地 DB 跑匹配，只输出计数/长度，*** 全掩码
├── scripts/verify-install.ps1 # 一键安装自验证（file:// 本地 / github 发布链双模式）
├── test/ghost-core.test.ts # 核心单元测试（bun/tsx 双运行时，无框架）
├── package.json / README.md / LICENSE(MIT) / .gitignore / DESIGN.md / tasks.md
```

### 3.1 history-source.ts（写权限：lane A）

```ts
export interface HistoryEntry {
  text: string    // 归一（\r\n→\n）+ trim 后文本——与完全相同排除、跨源去重键同口径
  lower: string   // 预计算小写副本（tleclaire 实测：省掉每键 lowercase 是最大优化）
}

export interface HistorySource {
  /** 最新在前；已去重、已过滤、已截断到上限 */
  entries(): HistoryEntry[]
  /** jsonl mtime 变化时重新合并；由外层定时调用，内部有变化检测 */
  refresh(): void
}

export function createHistorySource(options: {
  dataDirOverride?: string   // 测试用
  maxEntries?: number        // 默认 2000
  maxTextLength?: number     // 默认 2000 字符，防止贴进来的超长文本被建议
}): HistorySourceWithDebug   // 追加 whenReady() / readStats()，供冒烟与测试观测
```

实现要点：
- **DB 路径解析**（借鉴 tleclaire）：`OPENCODE_DB` 环境变量 > `~/.local/share/opencode/opencode.db`
  > 同目录 `opencode*.db` 中 mtime 最新者。
- **SQLite 打开**：优先 `import("bun:sqlite")`（TUI 宿主运行时），
  失败则尝试 `import("node:sqlite")`，再失败降级为 jsonl-only（不抛错，warn 一次，
  文案附各后端底层错误摘要，不掩盖真实原因）。只读打开，WAL 安全。
- **schema 自适应**：先试 V2 `SELECT data FROM session_message WHERE type='user'
  ORDER BY time_created DESC LIMIT ?`（LIMIT 为位置参数绑定 maxEntries，只物化最新
  N 行，新到旧；data JSON 的 `.text` 即 prompt 原文，若 data.parts 存在则拼接其中
  text parts）；抛错则试 V1 legacy `message JOIN part`（同样 LIMIT 绑定）；都失败降级 jsonl。
- **jsonl**：`~/.local/state/opencode/prompt-history.jsonl`，每行 `PromptInfo{text,...}`，
  末尾行最新，反转后放最前。
- **过滤**：内部换行先归一（`\r\n` → `\n`），trim 后长度 ≥ 2、长度 ≤ maxTextLength、
  不以 `/` 开头（宿主 slash 命令）。
- **合并去重**：jsonl（最新）在前 + DB 在后，`Set` 按归一后文本跨源去重，
  保留首个出现即最新，截断 maxEntries。
- **refresh()**：stat jsonl mtime，未变直接返回；变了重读 jsonl 与合并结果（DB 不重查）。

### 3.2 matcher.ts（写权限：lane A）

```ts
import type { HistoryEntry } from "./history-source"

export interface MatchOptions {
  minChars?: number         // 触发最小输入长度，默认 3（兼作防抖）
  maxCandidates?: number    // 候选上限，默认 5
  excludePrefixes?: string[] // 默认 ["/", "@"]，命中任一则不出建议
}

export function findCandidates(
  history: HistoryEntry[],
  rawInput: string,
  options: MatchOptions,
): HistoryEntry[]
```

实现要点：
- 防御过滤：输入 trim 后空 / 长度 < minChars / `excludePrefixes` 任一前缀命中 → 返回 `[]`。
- 与当前输入完全相同的候选不返回（`entry.text === trimmedInput`，不建议整句重复；
  该口径成立的前提是 3.1 的存储层归一 trim）。
- **三档分层**（档内最新优先，即列表顺序）：
  1. `entry.lower.startsWith(inputLower)`（前缀桶）
  2. `entry.lower.includes(inputLower)`（子串桶，排除已在前缀桶的）
  3. fuzzysort 相似度（排除前两桶已命中的）：`fuzzysort.go(inputLower, 剩余, { key: "lower", limit: maxCandidates })`，
     按分数降序。**实现时必须读 node_modules/fuzzysort 的 README 验证当前版本 API**
     （v3/v4 的对象数组 key 用法有差异），只把有匹配（非 null）的收进来。
     前两桶已够填满候选时跳过 fuzzy（合并后反正截断，省一次全量打分）。
- 合并：前缀桶 + 子串桶 + fuzzy 桶，去重，截断 maxCandidates。
- 纯函数、无状态；增量快路径不在这里（由 suggestion-store 处理）。

### 3.3 editor-bridge.ts（写权限：lane B）

```ts
export interface EditorBridge {
  /** 当前聚焦编辑器即 composer 的 textarea；未聚焦返回 null */
  current(): EditBufferLike | null
  /** 读当前输入全文 */
  inputText(): string | null
  /** 光标在文本末尾（fish/pi 共识：只在行尾出/接受建议） */
  cursorAtEnd(): boolean
  /** 整句替换当前输入（replaceText 保 undo） */
  acceptFullText(text: string): boolean
  /** 订阅输入变化；返回解绑函数 */
  onInput(handler: (text: string) => void): () => void
  /** 订阅光标移动；handler 收到移动后光标是否在行尾 */
  onCaretMove(handler: (caretAtEnd: boolean) => void): () => void
  /** 订阅外来编辑器聚焦（对话框/侧栏搜索，旧实例仍存活时）；返回解绑函数 */
  onForeignEditorFocus(handler: (foreignEditor: EditBufferLike) => void): () => void
  /** 启动 1.5s 身份自愈轮询（实例重建 + 同实例槽位覆写都由它兜底） */
  watch(): void
  /** 移除全部 hook、订阅与定时器；幂等 */
  dispose(): void
}

export function createEditorBridge(context: unknown): EditorBridge
```

实现要点（半官方 API，全部防御式编码）：
- `renderer = (context as any)?.renderer`，可选链每步判空；编辑器操作前判 `isDestroyed`。
- `plainText` getter 读全文；`cursorOffset` 判光标在末尾；`replaceText(text)` 接受整句。
- **双槽包装**：`onContentChange` 与 `onCursorChange` 两个监听槽都包一层
  （先调宿主原监听器再调我们的通知，各自 try/catch）；幂等（槽位现值已是我们的
  wrapper 则不动）。**Symbol.for 守卫**：每个 wrapper 挂模块级
  `installedWrapperSymbol` 标记，重新安装时若槽位现值带标记则先解包取出真正的
  宿主监听器再链——任何路径下（含宿主把 wrapper 迁到新实例）最多一层包装。
- **同实例槽位覆写自愈**：1.5s 轮询校验两个槽位现值仍是我们安装的 wrapper；
  被宿主覆写则**采纳宿主最新监听器为新的 original 重链**，陈旧的 original 丢弃、
  绝不恢复到宿主已弃用的赋值上。失效窗口 ≤ 1.5s。
- **实例重建 + 可信采纳**：轮询对比 `currentFocusedEditor()` 身份：旧实例已销毁 →
  新聚焦者即重建的 composer，采纳；旧实例仍存活而焦点移到别的编辑器 →
  对话框/侧栏输入，**拒绝包装**，触发 onForeignEditorFocus 让消费者清掉已显示建议。
- 所有异常吞掉并 console.warn 一次（warn-once），绝不让插件崩宿主。

### 3.4 suggestion-store.ts（写权限：lane B）

```ts
export interface SuggestionState {
  readonly input: string               // trim 后的触发输入
  readonly candidates: HistoryEntry[]  // 有序候选；index 选中当前展示
  readonly index: number               // 循环索引
}

export interface SuggestionStoreApi {
  evaluate(rawInput: string): void
  cycle(direction: 1 | -1): void
  clear(): void
  dismiss(): void
  current(): HistoryEntry | null
  hasSuggestion(): boolean
  state(): SuggestionState | null
  onStateChange(listener: () => void): () => void   // 返回解绑函数
}

export function createSuggestionStore(
  history: () => HistoryEntry[],
  settings: HistoryGhostSettings,   // durable storage 对象或内存兜底对象
): SuggestionStoreApi
```

命令式状态（**无任何 Solid 原语**，理由见 §1 反应式决策）：
`currentState` 普通对象 + `onStateChange` 监听集，每次提交变更后逐个通知（各自 try/catch）。
- `evaluate(rawInput)` 五层，顺序：
  - 第 0 层 **trim-once 归一**：入口 trim 一次；state.input、快路径比较、
    ghost-line 高亮切片全用 trim 后值（"帮我 " 与 "帮我" 高亮/延伸完全一致）；
  - dismiss 恢复：`dismissedForInput` 只压制被取消的那一个输入，输入变化即清空
    （re-arm，DESIGN §4）；
  - 防御过滤：开关关 / trim 后空 / 短于 minChars / excludePrefixes 命中 → null；
  - **增量快路径**（fish 防闪烁）：新输入逐字延长旧输入且当前候选
    `lower.startsWith(新输入.lower)` → **保留 candidates 数组引用与 index**，仅前移
    input，不重跑 matcher；
  - 否则 `findCandidates()` 全量匹配；空结果置 null。
- `cycle(direction)`：index 环形移动（无候选时不动）。
- `clear()`（接受后）、`current()`、`hasSuggestion()`（keymap enabled 用）、`state()`。
- `dismiss()`（Esc）：置 null 并记录 `dismissedForInput = state.input`。

### 3.5 ghost-line.tsx（写权限：lane B）

- 注册方式（在 tui.tsx 装配，见 3.7）：`context.ui.slot({ append: "session.composer.top", render: ... })`
  （claim 语义与精确签名以
  `...\opencode-db-insight\node_modules\@opencode\plugin\dist\tui\context.d.ts:199-231` 为准）。
- **命令式控制器**（`createGhostLine`，无 Solid 原语）：
  - `renderRow()` 每次宿主 slot render 返回**全静态 JSX**（静态树在任何打包形态下都能
    安全重挂）；`ref` 回调在创建时立即捕获渲染实例（jsx-runtime 无论模块图健康与否
    都会触发 ref）；
  - `refresh()` 从 store 读当前状态，直接 patch 捕获到的
    `TextRenderable.content` / `Renderable.visible`，调用方随后
    `renderer.requestRender()`，屏幕按树中现值重绘（"the tree flips; the screen
    paints when someone asks"）。
- 无建议时整行 `visible=false`（slot 收起）；有建议渲染一行：
  `建议前缀部分正常色 + 剩余后缀 dim 灰 + 右侧提示 "Tab 接受 · (2/5) ctrl+↑↓ 切换 · Esc 取消"`。
- 颜色：优先 `context.theme` 的 text.muted / text.base；拿不到就兜底固定灰色。
- 多行候选：只展示首行（typed + 后缀）+ dim `(+N 行)` 注记（tleclaire 方案；接受时仍替换整句）。
- 截断：总长度截 100 code units，加 `…`（CJK 精确宽度 v1 已知限制，记入 README）。

### 3.6 keymap.ts（写权限：lane B）

```ts
export function registerKeymap(context: unknown, deps: KeymapDeps): () => void
// 返回 cleanup：尽力注销 layer（宿主若自管 reactive scope 生命周期则为 no-op）
```

- **必须在 slot render 里注册**（setup() 直接调抛 "Keymap.Provider is missing"），
  且注册在**独立的全局 `append: "app"` slot** 内：app slot 存活整个 TUI 会话，
  跨会话切换不失效；`session.composer.top` slot 只做纯渲染（defect-2 修复：
  会话作用域注册会在离开会话时销毁 layer 且 once-guard 阻断重注册）。
- layer 定义：`mode: "global"`，`target: () => bridge.current()`，
  `enabled: () => settings.enabled && store.hasSuggestion() && keymap.mode.current() !== "autocomplete"`
  ——补全弹窗激活时 mode 为 "autocomplete"，本层整体失效，Tab 归还宿主补全（天然互斥，不抢优先级）。
- commands（store 变更类命令都带 **run 级一致性校验**：聚焦编辑器文本 trim 后
  === state.input，不匹配即 `return false` 归还按键——兜住 ≤1.5s 轮询竞态窗口内
  焦点落到对话框输入的场景）：
  - `history-ghost.accept`，bind = settings.acceptKey（默认 `"tab"`，可配 right/ctrl+y），
    run：无候选 / 一致性校验失败 / 光标不在行尾（`cursorAtEnd` 守卫）→ `return false`
    归还按键；通过则 `acceptFullText(候选.text)` → `store.clear()`，成功即消费事件。
  - `history-ghost.cycle-next` bind `ctrl+down`；`history-ghost.cycle-prev` bind `ctrl+up`
    （均带一致性校验）。
  - `history-ghost.dismiss` bind `escape`（带一致性校验：对话框的第一个 Esc 必须归还给对话框）。
  - `history-ghost.toggle`，`palette: true`，title "History Ghost: 开关历史建议"，run：onToggle。
- 返回的 cleanup 在 tui.tsx 的统一清理中调用（见 3.7）。

### 3.7 tui.tsx（装配，写权限：lane B）

```
Plugin.define({ id: "history-ghost", setup(context) })
```
- 创建 settings：`context.storage.store("history-ghost-settings", { initial: {...默认值} })`，
  try/catch 兜底——storage API 不可用时退回普通内存对象（开关仍生效，只是不持久化）。
- 创建 historySource → editorBridge → suggestionStore → ghostLine，接线：
  - `store.onStateChange` → `ghostLine.refresh()` + `renderer.requestRender()`；
  - `bridge.onInput` → 光标在行尾才 `evaluate(text)`，否则 `clear()`；
  - `bridge.onCaretMove` → 光标离开行尾即 `clear()`（纯光标移动不触发 onContentChange）；
  - `bridge.onForeignEditorFocus` → `clear()`（对话框聚焦时不残留幽灵行）；
  - `bridge.watch()` 启动自愈轮询。
- keymap 注册于独立 `append: "app"` slot 的 render 内（once-guard，见 3.6）；
  `session.composer.top` slot 只渲染 `ghostLine.renderRow()`。
- `setInterval(3000)` 调 `historySource.refresh()`。
- 返回 cleanup（幂等 disposeAll）：clear 3s refresh interval；退订全部四组监听
  （onStateChange / onInput / onCaretMove / onForeignEditorFocus）；`bridge.dispose()`；
  keymap cleanup；**app slot 与 composer.top 双 slot dispose**。

### 3.8 settings 默认值

`{ enabled: true, acceptKey: "tab", minChars: 3, maxCandidates: 5,
maxEntries: 2000, maxTextLength: 2000, excludePrefixes: ["/", "@"] }`

## 4. 边界情形

| 情形 | 行为 |
|---|---|
| 空输入 / < 3 字符 | 不出建议 |
| 输入以 / 或 @ 开头 | 不出建议（宿主命令/引用的补全域） |
| 内置 @// 补全弹窗激活 | keymap 层 enabled=false，Tab 归宿主，幽灵行可保留但不响应 Tab |
| 光标不在末尾 | 不出建议；纯光标移动经 onCaretMove 即刻清掉已显示建议（fish/pi 共识） |
| 输入与候选完全相同 | 该候选被排除（存储层归一 trim 保证该口径成立，见 3.1/3.2） |
| Esc 后继续输入 | 输入变化即重新评估（dismissed 只对同一输入生效） |
| 多行历史候选 | 首行展示 + (+N 行)，Tab 接受替换整句 |
| 多行历史内部 \r\n | 入库前归一为 \n（渲染按 "\n" 切行，无杂散控制符、切割不偏移） |
| 候选首尾空白 | 存储层归一 trim（去重键与"完全相同排除"同口径，防接受后同条建议立即重弹） |
| DB 打不开 / schema 变了 | 降级 jsonl-only，warn 一次（附底层原因），功能不断 |
| 对话框/外来编辑器聚焦 | 旧实例仍存活 → 拒绝包装新实例，onForeignEditorFocus 通知消费者清建议；Tab/Esc 经 run 级校验归还 |
| 同实例监听槽位被宿主覆写 | 1.5s 自愈轮询检测后重链到宿主最新监听器；Symbol.for 守卫保证最多一层包装 |
| editor 实例被宿主重建 | 1.5s 轮询身份对比：旧实例销毁 → 采纳新聚焦者重挂 wrapper |
| storage API 不可用 | 内存默认对象兜底（设置不持久化但功能可用，warn 一次） |
| 插件任何异常 | 全部 try/catch 吞掉 warn，绝不崩宿主 |

## 5. 已知限制（记入 README）

1. 灰字在输入框上方一行而非框内原生内联（V2 API 硬限制，上游 OpenTUI "inline ghost
   suffix" 是唯一无损升级路径）。
2. CJK 宽字符截断按 code units，极端情况视觉不精确。
3. 历史含敏感信息时建议同样可见于屏幕（历史来自本机 DB，不外发；不做 secret 过滤 v1）。
4. fuzzy 档对超长历史（>2000 已截断）不保证，且与宿主内置补全的 fuzzysort 阈值策略不同。
5. **对话框输入防劫持是启发式的**：以"旧输入框实例是否已被宿主销毁"区分重建的
   composer 与对话框输入。极小概率的首挂载窗口内（插件加载瞬间恰有对话框聚焦）
   该对话框会被临时误认，关闭后自愈，重启即彻底消除（详见 README 第 5 条）。
6. 终端复用器（tmux/screen 等）不区分 ctrl+方向键与普通方向键时候选循环不可用，
   其余功能不受影响（README 第 6 条）。

## 6. 验证方法

1. `npx esbuild src/tui.tsx --loader:.tsx=tsx --jsx=automatic --log-level=error` 零报错。
2. `test/ghost-core.test.ts`：核心单元测试（无框架、自写断言），
   `bun test/ghost-core.test.ts` 与 `npx tsx test/ghost-core.test.ts` 双运行时全 PASS。
3. `scripts/dev-smoke.ts`：对本地真实 DB 跑 findCandidates，**只输出计数与长度，
   候选文本以固定 `***` 全掩码，绝不打印任何明文片段**（历史是隐私），
   验证延迟 < 1ms/次。
4. `pwsh scripts/verify-install.ps1`：一键安装自验证（file:// 本地模式默认；
   发布后 `-Mode github` 走发布链），全部 PASS 才算安装到位。
5. 本机安装（opencode.json `plugins: ["file://..."]`）→ 重启 TUI → 手测清单（见 tasks.md T11）。
6. 对照本 DESIGN 与 tasks.md 收敛检查。
