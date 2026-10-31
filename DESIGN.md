# opencode-history-ghost 设计文档

## 0. 一句话

用户在 OpenCode V2 TUI 输入框打字时，基于历史输入做分层匹配（前缀 > 子串 > fuzzy），
把最匹配的一条以灰字**内联**画在输入框内、光标之后（已输入部分正常色 + 未输入后缀灰显），
内联无法定位时降级为输入框正上方一行幽灵建议；Tab 接受即用整句替换当前输入；
候选可循环，功能可开关，匹配为纯内存亚毫秒级。

## 1. 调研结论（决策依据，详细报告见会话记录）

| 来源 | 结论 | 本设计采纳 |
|---|---|---|
| tleclaire/opencode-autocomplete（V1，无 LICENSE） | 功能几乎一致但 V1 API + 无许可证，不可复用代码 | 借鉴：DB 路径解析、预计算小写副本、README 坑清单 |
| Hermes（prompt_toolkit） | 纯前缀最新优先，每键后台协程单飞，O(n) 内存扫描够快 | 采纳：内存扫描 + 最新优先；不需要 Trie |
| fish shell | 增量应用防闪烁；Tab 让位补全弹窗；后台防抖 | 采纳：增量应用 + Tab mode 隔离 |
| 官方 issue #5558 | OpenCode 无插件贡献补全项的钩子；内置补全用 fuzzysort | fuzzy 档直接用 fuzzysort（MIT，宿主同款） |
| opencode 源码实证（exp-2） | currentFocusedEditor 可读写输入框；keymap 可绑 Tab 且与 autocomplete mode 天然互斥；session.composer.top slot 可挂幽灵行；~/.local/state/opencode/prompt-history.jsonl（50 条）+ opencode.db（全量用户消息） | 全部采纳 |

**明确不做**：打字后把灰字真插进输入框 buffer（原生不支持，extmark 方案污染提交/撤销语义，
上游 #2207 有事故记录）。视觉内联改为**覆盖层**实现：在 `session.composer.top` 上挂 0 尺寸
anchor + 内嵌绝对定位 `<text>`，不触碰 buffer；内联无法定位时回退到输入框正上方幽灵行。

**反应式决策（defect-1）**：插件侧 node_modules 携带 solid-js / @opentui/solid 的影子副本，
宿主（v2.0.29）只对预编译单文件 bundle 的 hoisted import 稳定替换自有模块实例
（usage-meter 坑 #13/#16）；插件侧 createSignal/createMemo 落在影子模块图上，其渲染
副作用不进宿主 slot 机制，界面冻结在挂载时快照。因此本插件**全链不用任何 Solid 原语**：
状态是普通对象 + 显式 onStateChange 监听集，UI 用静态 JSX + ref 捕获渲染实例 +
命令式 patch + renderer.requestRender()。

## 2. 架构与数据流

```
按键 → TextareaRenderable.onContentChange（插件包装层，同进程同步，零 IPC）
      → editor-bridge 使用 editBuffer.getTextRange(0, cursorOffset) 读取光标前缀
      → suggestion-store.evaluate(光标前缀)
         ├─ 第 0 层 trim-once 归一：raw editor text 在入口 trim 一次，
         │   state.input、增量快路径比较、高亮切片全用 trim 后值
         ├─ dismiss 恢复（Esc 只压制被取消的那一个输入；输入变化立即 re-arm）
         ├─ 防御过滤（开关关 / 空 / 短于 minChars / excludePrefixes @ 或 /）
         ├─ 增量快路径（新输入仍是当前建议前缀 → 只前移 input，不重算，防闪烁）
         └─ matcher.findCandidates()：前缀桶 > 子串桶 > fuzzysort 桶，档内最新优先
     → ghost-line（session.composer.top slot：静态 JSX + ref 捕获渲染实例；
       store.onStateChange 触发命令式 patch content/visible + renderer.requestRender()）

Tab → 建议快捷键 layer（独立 append:"app" slot 内注册；mode:"global"，
        **layer 级不设 target/enabled**（宿主只解析一次 thunk，为 null 会整层失效）；
        门控全部放进命令 run()：每次按键重判身份、候选快照全文及光标前缀、
        开关与宿主 mode，不满足即 return false 归还按键）
       → editor.replaceText(候选整句)  → suggestion-store.clear()
命令面板开关 → 同一 app slot 中另一个无绑定按键的 global layer；
               不受候选、总开关状态或 composer 焦点限制

历史数据源（只读）：
  opencode.db（SQLite 只读打开；查询 LIMIT maxEntries 参数绑定，只物化最新 N 行，
  新到旧；启动加载一次，不重查）
  + prompt-history.jsonl（mtime 轮询 3s，增量合并，弥补"本次会话刚提交的 prompt 尚未入库"）
```

## 3. 模块划分与接口契约

```
opencode-history-ghost/
├── index.ts / tui.js   # 仓库根目录入口桥接（目录式 Host.resolve 探测）
├── dist/tui.js         # npm run build:tui 生成的单文件业务 bundle；须随发布交付
├── src/
│   ├── index.ts            # 服务端入口占位（纯 TUI 插件，export {}）
│   ├── tui.tsx             # 装配：Plugin.define + slot + cleanup（不做业务逻辑）
│   ├── history-source.ts   # 数据源：SQLite + jsonl 加载/归一/去重/增量刷新
│   ├── matcher.ts          # 纯函数匹配引擎
│   ├── editor-bridge.ts    # currentFocusedEditor 访问 / 双槽包装 / 自愈轮询 / 接受
│   ├── composer-identity.ts # 私有 Prompt 树 footer marker 身份证明；未知结构 fail-closed
│   ├── suggestion-store.ts # 命令式状态（候选列表、循环索引、开关）+ onStateChange 监听集
│   ├── ghost-line.tsx      # 候选提示行 UI 控制器（静态 JSX + ref + 命令式 patch）
│   ├── ghost-overlay.tsx   # 内联后缀的文本数学 + 屏幕几何（纯函数，无渲染）
│   ├── ghost-overlay-render.tsx # 内联覆盖层：composer.top 0 尺寸 anchor + 绝对定位 <text>
│   ├── string-width.ts     # 东亚宽度感知的显示格测量（覆盖层定位用）
│   ├── keymap.ts           # 建议快捷键与独立 palette toggle 两层（返回 cleanup）
│   ├── probe-log.ts / context-probe.ts / thrown-dump.ts  # 开发期诊断探针（发布前移除）
├── scripts/dev-smoke.ts    # 开发冒烟：对本地 DB 跑匹配，只输出计数/长度，*** 全掩码
├── scripts/verify-install.ps1 # 一键安装自验证（github 发布链；维护者另有本地 file 模式）
├── docs/tui-plugin-pitfalls.md    # TUI 插件开发避坑清单（本仓库实证）
├── test/ghost-core.test.ts # 核心单元测试（bun/tsx 双运行时，无框架）
├── test/ghost-line-inline.test.ts # 内联后缀文本/几何 + 覆盖层挂载冒烟（真实 textarea）
├── test/composer-identity.test.ts # 真实 renderer 模拟 Prompt 树身份负例
├── test/entry-resolution.test.ts # 根目录 server/tui 入口解析回归
├── test/tui-delivery.test.ts # 静态验证真实交付 bundle、external 及桥接（非宿主加载）
├── test/history-reassessment.test.ts # 历史变化时同输入重评估与 Esc 压制回归（非真机）
├── package.json / README.md / LICENSE(MIT) / .gitignore / DESIGN.md / tasks.md
```

**入口解析边界与交付决策（一键安装）**：用户通过 `opencode plugin add github:dubuqiangu/opencode-history-ghost` 一键安装，不需要也不应登记任何本地 file URI。宿主 `@opencode/plugin` 把 `server`（`exports["."]` → `src/index.ts`）与 `tui`（`exports["./tui"]` → `./dist/tui.js`）当作两个独立入口解析；TUI 进程只加载 `.tui` 入口，server 入口因 `context.ui.slot` 不是函数而提前返回（纯 TUI 插件）。目录式 `Host.resolve` 对无包名目录探测根级 `server`/`index` 和 `tui`，故根级 `tui.js` 只转发 `./dist/tui.js`，两条 TUI 解析路径共用同一交付文件。针对 OpenTUI 模式冲突，本项目选用 `npm run build:tui` 生成单文件业务 bundle，发布时必须包含 `dist/tui.js`，将 `@opentui/*`、`solid-js` 和宿主 SDK 外置而非带入影子实例；动态 `bun:sqlite` 是合法的 Bun 运行时导入。研究过的宿主源码为 v2.0.26 / 本地 SDK 2.0.29，不能由此推断真实 v2.0.32 的加载表现。

**真机状态**：快捷键层与 slot 注册在真机上已被证实生效（`probe-slot-errors.txt` 零 `recordFailure`；用户验收快捷键全部生效）。`Host.resolve` 只证明定位入口；本地 SDK 的 `Host.load` 回归、交付文件的静态回归和 external 化的 esbuild 构建均不能证明真实宿主能导入 external 或共享 OpenTUI 实例；T11/T12 不因此视为完成。

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
- **schema 自适应与来源优先级**：先分页扫描 V2 `session_message`，再在仍有容量时扫描 V1 legacy `message JOIN part`；两源各按自身创建时间倒序，跨源不比较不同时间基准。已从同步 LIMIT/OFFSET 改为参数绑定 keyset 游标（V2 `(time_created,rowid)`、legacy `(time_created,message.rowid,part.rowid)`），NULL 时间按 DESC 排序末尾单独扫描，每页最多 256 行并以 `setImmediate` 让出；归一/过滤/去重后累积到 maxEntries。某源缺失或失败不阻断另一源，两源都失败才降级 jsonl。V2 data JSON 的 `.text` 为 prompt 原文，若 data.parts 存在则拼接 text parts。
- **P2 已缓解且完成 SQL 代码级复核，非真机验收**：oracle 未发现静态库遗漏/重复、NULL 阶段或 Node 接口问题；legacy NULL 续页现用 `(message.rowid,part.rowid) < (?,?)`，另有 112k 行合成大库及 60k 消息/120001 parts NULL 时间夹具回归。后者本机观测旧 8.7s→新 136ms，不作为性能保证。并发 WAL 跨页不持有同一快照（新插入的更晚行可能不收、旧行可能收）；非 NULL 单消息海量 parts 与无索引单页仍可能阻塞。真实 DB 和宿主 TUI 流畅度未验证。
- **jsonl**：`~/.local/state/opencode/prompt-history.jsonl`，每行 `PromptInfo{text,...}`，
  末尾行最新，反转后放最前。
- **过滤**：内部换行先归一（`\r\n` → `\n`），trim 后长度 ≥ 2、长度 ≤ maxTextLength、
  不以 `/` 开头（宿主 slash 命令）。
- **合并去重**：jsonl > V2 > legacy，各源内部最新在前；`Set` 按归一后文本跨源去重，
  保留优先源的首次出现，截断 maxEntries（不保证跨来源全局时间最新）。
- **refresh()**：stat jsonl mtime，未变直接返回；变了重读 jsonl 与合并结果（DB 不重查）。

**已确认的重评估缺口与预期修复边界**：DB 异步 `whenReady()` 或 jsonl mtime 导致候选池变化时，若 composer 输入没有变化，现有链路不会重新评估建议。预期仅在历史源实际变化、且当前 composer 身份可信时，重读当前光标前缀并评估；不得借历史刷新绕过 `Esc` 对**同一输入**的压制，输入变化才恢复。回归应覆盖静止输入的 DB/jsonl 到达、未知/外来编辑器 fail-closed 与同输入 Esc 抑制；这不是已完成的真机修复证明。

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
  /** 当前聚焦且由身份适配器证明的 composer textarea；否则返回 null */
  current(): EditBufferLike | null
  /** 读当前输入全文 */
  inputText(): string | null
  /** 光标在文本末尾（保留兼容旧桥接调用） */
  cursorAtEnd(): boolean
  /** 可信全文 + native 光标前缀 + display-cell offset；未知映射返回 null */
  caretSnapshot(): EditorSnapshot | null
  caretPrefix(): string | null
  /** 整句替换当前输入（replaceText 保 undo） */
  acceptFullText(text: string): boolean
  /** 订阅输入变化；返回解绑函数 */
  onInput(handler: (text: string) => void): () => void
  /** 订阅光标移动；handler 收到移动后光标是否在行尾（调用方每次重读 prefix） */
  onCaretMove(handler: (caretAtEnd: boolean) => void): () => void
  /** 订阅外来编辑器聚焦（对话框/侧栏搜索）；返回解绑函数 */
  onForeignEditorFocus(handler: (foreignEditor: EditBufferLike) => void): () => void
  /** 启动 1.5s 身份自愈轮询（实例重建 + 同实例槽位覆写都由它兜底） */
  watch(): void
  /** 移除全部 hook、订阅与定时器；幂等 */
  dispose(): void
}

export function createEditorBridge(context: unknown, identity: ComposerIdentity): EditorBridge
```

实现要点（半官方 API，全部防御式编码）：
- `renderer.currentFocusedEditor` 是 **getter 属性，不是函数**（`@opentui/core/renderer.d.ts:418`）；直接读取，桥接类型绑定 SDK 的 `CliRenderer` 属性；空焦点返回 null，轮询不可把 null 传进双槽完整性校验。编辑器操作前判 `isDestroyed`。
 - `plainText` getter 读全文；`cursorOffset` 是显示单元偏移，不能当作 JS 字符索引；使用 SDK `editBuffer.getTextRange(0, cursorOffset)` 读光标前缀，并用 range 拼接全文及 `measureText(prefix)` 检查边界；映射不可靠则不建议。`replaceText(text)` 接受整句（包括光标后的原文）。
- **双槽包装**：`onContentChange` 与 `onCursorChange` 两个监听槽都包一层
  （先调宿主原监听器再调我们的通知，各自 try/catch）；幂等（槽位现值已是我们的
  wrapper 则不动）；首次安装即使槽位和未安装记录均为 undefined，也必须分别安装两槽。**Symbol.for 守卫**：每个 wrapper 挂模块级
  `installedWrapperSymbol` 标记，重新安装时若槽位现值带标记则先解包取出真正的
  宿主监听器再链——任何路径下（含宿主把 wrapper 迁到新实例）最多一层包装。
- **同实例槽位覆写自愈**：1.5s 轮询校验两个槽位现值仍是我们安装的 wrapper；
  被宿主覆写则**采纳宿主最新监听器为新的 original 重链**，陈旧的 original 丢弃、
  绝不恢复到宿主已弃用的赋值上。失效窗口 ≤ 1.5s。
- **实例重建 + 可信采纳**：轮询只对 `composer-identity` 证明的新聚焦 composer
  重装 wrapper；旧实例销毁不构成采纳证据。外来/未知编辑器拒绝包装，触发
  onForeignEditorFocus 清掉已显示建议；按键运行时重新证明身份。
- **私有 Prompt 树身份适配器**：按 OpenCode v2.0.29 的 `prompt.footer` slot
  零尺寸 marker 与当前 session 路由关联；沿 `footer → Prompt root`，验证
  兄弟 input border → padding → textarea 的父子链、渲染树连通性和唯一性。
  聚焦 editor 必须恰好是该 textarea。未知路由、树结构、多个活跃 marker、
  未连接节点一律 fail-closed；**目前未检查宿主版本号**。真实 renderer 模拟
  回归尚未证实真实宿主 TUI 的 Prompt 父子链，也未确认真实宿主与插件是否共享
  OpenTUI 构造器；v2.0.29 是结构参考，不是已实施的宿主版本门槛。
- 所有异常吞掉并 console.warn 一次（warn-once），绝不让插件崩宿主。
- **SDK 回归**：Bun 使用真实 `createTestRenderer`、`TextareaRenderable`、Solid slot + 固定历史源验证 getter、有/无宿主 listener、空焦点轮询及 ghost 显示；Node 的 OpenTUI native FFI 不可用时仅运行假 renderer 逻辑用例。

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
- **建议快捷键层**：`mode: "global"`，**layer 级不设 `target` / `enabled`**——
   宿主只解析一次该 thunk，注册当时为 null（身份未证明/未聚焦）会导致**整层被移除**，
   快捷键全灭（真机根因，见 `docs/tui-plugin-pitfalls.md` #1）。门控全部放进
   命令 `run()`：每次按键重判"开关开 && 有建议 && 宿主 mode 非 `autocomplete`/`modal`
   && 身份可证明且光标前缀与候选快照一致"，不满足即 `return false` 归还按键。
   补全弹窗激活时宿主 mode 为 "autocomplete"，run 判定失败，Tab 归还宿主补全
   （天然互斥，不抢优先级）。
- 建议快捷键层的 commands（store 变更类命令都带 **run 级身份 + 文本一致性校验**：当前
   session 的 marker 结构必须证明聚焦 composer，且其光标前缀 trim 后 === state.input，全文/前缀/offset 与产生候选时的快照一致；
  不匹配即 `return false` 归还按键，对话框文本相同也不能接管）：
  - `history-ghost.accept`，bind = settings.acceptKey（默认 `"tab"`，可配 right/ctrl+y），
     run：无候选 / 一致性校验失败 / 无可信光标前缀 → `return false`
    归还按键；通过则 `acceptFullText(候选.text)` → `store.clear()`，成功即消费事件。
  - `history-ghost.cycle-next` bind `ctrl+down`；`history-ghost.cycle-prev` bind `ctrl+up`
    （均带一致性校验）。
  - `history-ghost.dismiss` bind `escape`（带一致性校验：对话框的第一个 Esc 必须归还给对话框）。
- **独立命令面板层**：`mode: "global"`，无按键绑定、无 `target` 或建议状态 `enabled` 限制；
  唯一命令 `history-ghost.toggle`，`palette: true`，title "History Ghost: 开关历史建议"，
  run：onToggle。因此开关关闭、无候选或 composer 无焦点时命令仍可从面板调用。
- 返回的 cleanup 在 tui.tsx 的统一清理中调用（见 3.7）；分别尽力注销两层。

### 3.7 tui.tsx（装配，写权限：lane B）

```
Plugin.define({ id: "history-ghost", setup(context) })
```
- 创建 settings：`context.storage.store("history-ghost-settings", { initial: {...默认值} })`，
  try/catch 兜底——storage API 不可用时退回普通内存对象（开关仍生效，只是不持久化）。
- 创建 historySource → composerIdentity → editorBridge → suggestionStore → ghostLine，接线：
  - `store.onStateChange` → `ghostLine.refresh()` + `renderer.requestRender()`；
   - `bridge.onInput` → 取得可信光标前缀后 `evaluate(prefix)`，不可映射时 `clear()`；
   - `bridge.onCaretMove` → 光标每次移动立即重新读取并评估前缀（纯光标移动不触发 onContentChange）；
  - `bridge.onForeignEditorFocus` → `clear()`（对话框聚焦时不残留幽灵行）；
  - `bridge.watch()` 启动自愈轮询。
- keymap 注册于独立 `append: "app"` slot 的 render 内（once-guard，见 3.6）；
  `session.composer.top` slot 只渲染 `ghostLine.renderRow()`；另在
  `prompt.footer` slot 注册零尺寸 marker，供 composerIdentity 证明身份。
 - `setInterval(3000)` 调 `historySource.refresh()`；预期在 jsonl mtime 引发历史实际变化或 DB `whenReady()` 完成时，仅对可信 composer 重新评估静止输入（不重置同输入 Esc 压制）。当前缺少该通知闭环，不能把 3 秒轮询等同于建议自动刷新。
- 返回 cleanup（幂等 disposeAll）：clear 3s refresh interval；退订全部四组监听
  （onStateChange / onInput / onCaretMove / onForeignEditorFocus）；`bridge.dispose()`、`composerIdentity.dispose()`；
  keymap cleanup；**app、composer.top 与 prompt.footer 三个 slot dispose**。

### 3.8 settings 默认值

`{ enabled: true, acceptKey: "tab", minChars: 3, maxCandidates: 5,
maxEntries: 2000, maxTextLength: 2000, excludePrefixes: ["/", "@"] }`

### 3.9 ghost-overlay.tsx / ghost-overlay-render.tsx（内联覆盖层，写权限：lane B）

纯 TUI 视觉内联：把候选相对光标前缀的**未输入后缀**以灰色画在输入框内、光标之后。两层分工：
- `ghost-overlay.tsx`（`computeInlineSuffixFromPrefix` / `resolveOverlayGeometry`）：**纯函数**，
  后缀文本数学 + 屏幕几何，不渲染、不导入 solid 原语、不写编辑器。
- `ghost-overlay-render.tsx`（`createInlineGhostOverlay`）：在 `session.composer.top` 上
  claim 一个 slot，`renderOverlay()` 返回**单根 0 尺寸正常流 anchor + 内嵌绝对定位 `<text>`**，
  `refresh()` 命令式 patch 该节点；不创建/销毁/重挂，宿主 reconciler 看不到 churn。

几何契约（真机取证后定案，见 `docs/tui-plugin-pitfalls.md` #2/#3/#4/#5）：
- **后缀文本与起始格同源**：`resolveCaretPrefixText(editor)` 用 `editBuffer.getTextRange(0, cursorOffset)`
  按**显示格**取真实前缀（`cursorOffset` 不是码元）；同一前缀再经 `caretCellFromPrefix`（`stringWidth`）
  推出光标格。**不**把文本取自 `cursorOffset`、位置取自 `logicalCursor` 这两个不同字段。
- **位置优先 `visualCursor`**：`resolveOverlayGeometry` 优先用原生视口相对的
  `visualCursor.visualRow/visualCol`（软换行与滚动已计入），仅在缺失时回退到
  `logicalCursor − scrollY/textBufferView.scrollX`。真机 `EditBufferRenderable` 无
  `textBufferView`（真属性 `editorView`），故该后备的水平滚动恒为 0，属已知降级。
- 几何任一必需字段缺失/非有限（screenX/x、width、padding、光标行列）即返回 `null` →
  覆盖层隐藏，**上方幽灵行保底**。任何异常吞掉，绝不崩宿主。

## 4. 边界情形

| 情形 | 行为 |
|---|---|
| 空输入 / < 3 字符 | 不出建议 |
| 输入以 / 或 @ 开头 | 不出建议（宿主命令/引用的补全域） |
| 内置 @// 补全弹窗激活 | keymap 层 enabled=false，Tab 归宿主，幽灵行可保留但不响应 Tab |
| 光标不在末尾 | 仅用光标前内容匹配；Tab 替换全文，光标后内容不参与匹配；移动即重新评估。光标映射不确定则 fail-closed |
| 输入与候选完全相同 | 该候选被排除（存储层归一 trim 保证该口径成立，见 3.1/3.2） |
| Esc 后继续输入 | 输入变化即重新评估（dismissed 只对同一输入生效） |
| 多行历史候选 | 首行展示 + (+N 行)，Tab 接受替换整句 |
| 多行历史内部 \r\n | 入库前归一为 \n（渲染按 "\n" 切行，无杂散控制符、切割不偏移） |
| 候选首尾空白 | 存储层归一 trim（去重键与"完全相同排除"同口径，防接受后同条建议立即重弹） |
| DB 打不开 / schema 变了 | 降级 jsonl-only，warn 一次（附底层原因），功能不断 |
| 对话框/外来编辑器聚焦 | 无当前路由下唯一 footer marker 结构证明 → 拒绝包装，onForeignEditorFocus 清建议；Tab/Esc 经身份与文本 run 级校验归还 |
| 同实例监听槽位被宿主覆写 | 1.5s 自愈轮询检测后重链到宿主最新监听器；Symbol.for 守卫保证最多一层包装 |
| editor 实例被宿主重建 | 1.5s 轮询仅在新聚焦者由当前 session marker 结构唯一证明时重挂 wrapper；旧实例销毁不构成证据 |
| storage API 不可用 | 内存默认对象兜底（设置不持久化但功能可用，warn 一次） |
| 插件任何异常 | 全部 try/catch 吞掉 warn，绝不崩宿主 |

## 5. 已知限制（记入 README）

1. 框内内联覆盖层已实现（`session.composer.top` 绝对覆盖层），但当前宿主真机验收中灰字
   **仍显示在输入框上方**——内联路径未生效时降级为上方幽灵行，根因待真机诊断。
2. CJK 宽字符截断按 code units，极端情况视觉不精确。
3. 历史含敏感信息时建议同样可见于屏幕（历史来自本机 DB，不外发；不做 secret 过滤 v1）。
4. fuzzy 档对超长历史（>2000 已截断）不保证，且与宿主内置补全的 fuzzysort 阈值策略不同。
5. composer 身份依赖 OpenCode v2.0.29 私有 Prompt 树 footer marker 结构。
   未知树、路由、多个活跃 marker 必须 fail-closed；代码尚未检查宿主版本号，
   升级后可能停用建议。真实 renderer 模拟回归不等于宿主 TUI 父子链验证；
   T11/T12 真机验收仍未完成（详见 README 第 5 条）。
6. 终端复用器（tmux/screen 等）不区分 ctrl+方向键与普通方向键时候选循环不可用，
   其余功能不受影响（README 第 6 条）。

## 6. 验证方法

 1. 发布前 `npm run build:tui` 生成并随包交付 `dist/tui.js`；单文件 bundle 的任意 `src/` 改动都要求重新构建 dist 并重跑交付测试。`npx esbuild src/tui.tsx --loader:.tsx=tsx --jsx=automatic --log-level=error` 仅检查入口 TSX 语法转换，**无 `--bundle`，不检查完整导入图**；另以 `--bundle --platform=node --external:@opentui/core --external:@opentui/solid --external:@opencode/plugin --external:node:*` 构建本地依赖图（详见 README 开发命令），这些临时检查产物不是发布产物。三者均不证明 external 的运行时可用性或真实宿主加载。
2. `test/ghost-core.test.ts`：核心单元测试（无框架、自写断言），
   `bun test/ghost-core.test.ts` 与 `npx tsx test/ghost-core.test.ts` 双运行时全 PASS。
3. `scripts/dev-smoke.ts`：本机历史只观测 DB 成功加载次数及合并条目数（并非 DB 独立条目数），**候选文本以固定 `***` 全掩码，不输出明文**。无 DB 时显示未验证、可降级 jsonl-only；需真实 DB 门槛时显式加 `--require-real-db`，失败退出非零。默认性能门槛是合成 2000 条非个人历史分别覆盖前缀/子串/fuzzy，预热 100 次后两轮各 101 次 `findCandidates` 取较快轮 p95 <1ms，失败退出非零；不包含 DB 加载、渲染和 I/O，也不保证真实历史或每次调用 <1ms。
  4. `pwsh test/verify-install.test.ps1`：静态解析验证脚本并用临时 fixture 验证错误 URI、仅服务端注册、缺失/无效 v2 TUI 配置、无关配置字段、同数量不同内容以及 exports 指向有效 src 但根入口为空时 Host.resolve 失败的负例，不触碰真实宿主配置或更新宿主。
    5. `pwsh scripts/verify-install.ps1 -Mode github`（发布 / 维护者）：**会执行 `plugin update`、更改宿主安装，仅获许可时运行**；逐项运行十一项独立 Bun 进程（ghost-core、editor-bridge-regression、tui-load-diagnostic、caret-prefix-accept、history-completeness、ghost-remount、composer-identity、history-scan-performance、entry-resolution、tui-delivery、history-reassessment；后三项用 `bun test`），防 mock 串扰，并检查 PASS 与退出码；其中 `history-scan-performance` 分别用 112k 行合成大库与 60k 消息/120001 parts NULL 时间夹具验证扫描及响应性。tui-delivery 静态检查真实 `dist/tui.js`，不是 graph-check；github 模式逐项核对 git tracked `src/`/`scripts/` 路径及 SHA256，再比对安装包 bundle 与根桥接文件哈希。自动 PASS 不是 TUI 真机验收，T11/T12 仍未完成。维护者本地另有 `-Mode file`（依赖临时本地挂载，非用户安装路径），本设计以 github 一键安装为准。
6. 按实际安装来源重启 TUI → 手测清单（见 tasks.md T11），核对是否实际加载与读取 DB。
7. 对照本 DESIGN 与 tasks.md 收敛检查。

最新复核未发现新增 P0/P1，可安排受控 T11/T12 宿主真机验收，但目前均未完成。尤其需确认真实 `prompt.footer` 父子链与宿主/插件 OpenTUI 构造器共享；高重复历史同步 OFFSET 启动阻塞 P2 已由 keyset 与逐页让出缓解，oracle SQL 代码级复核已完成，仍待真实 DB 与真机验证；合成夹具 PASS 不保证无索引单页不会阻塞。

当前真实 TUI 灰字缺席的原因尚未确定；独立 Bun 回归与构建/交付静态检查均不能替代 T11/T12，不能据此声明真机已通过。

### 光标语义变更（自动验证，尚待 T11/T12）

原行尾限定已改为光标前缀匹配。真实 OpenTUI `TextareaRenderable` 实测宽字、ZWJ emoji、组合音符、tab 和换行的 `cursorOffset` 与 `editBuffer.getTextRange`：光标前缀由 native display-cell range 获得，只有 `prefix + suffix === plainText` 且 `measureText(prefix) === cursorOffset` 才接受；缺 native buffer 的假编辑器只允许 JS 末尾，未知内点拒绝。按键处理前重读当前全文和前缀，对比展示候选时保存的全文/offset/前缀和可信 composer 身份；autocomplete/modal 一律让位。原有同实例/行尾 `replaceText` 行为保留，T11/T12 真机仍未验收。
