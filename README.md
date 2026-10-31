# opencode-history-ghost

[OpenCode](https://opencode.ai) V2 TUI 插件：在输入框打字时基于**本机历史输入**给出灰字建议。设计上把未输入的后缀以灰色**内联**画在输入框内、光标之后（挂在 `session.composer.top` 的绝对定位覆盖层）；内联无法定位时**降级**为输入框正上方的一行幽灵建议。按 `Tab` 即用整句替换当前输入。

```
┌──────────────────────────────────────────────────────────────┐
│ > 帮我写一个解析 CSV 的 Python 脚本▍                          │ ← 输入框（▍光标；其后灰字=未输入后缀）
└──────────────────────────────────────────────────────────────┘
  候选 / 降级提示行：Tab 接受 · (1/5) ctrl+↑↓ 切换 · Esc 取消
```

- **内存匹配**：三层匹配（前缀 > 子串 > fuzzy，与宿主内置补全同款 fuzzysort 引擎）。`dev-smoke.ts` 以 2000 条非个人合成历史分别覆盖三桶，预热后每桶测两轮各 101 次 `findCandidates`，取较快轮 p95，断言 **<1ms/次**；仅覆盖匹配函数，不含加载、渲染及 I/O，也不保证每次调用都低于 1ms。
- **仅本机数据零外发**：历史只读本机 `opencode.db` 与 `prompt-history.jsonl`，不做任何网络上行，无 IPC、无第三方服务
- **静默降级**：DB 打不开或 schema 不适配时自动降级 jsonl-only（日志一次性 warn），主功能不断、**绝不崩溃宿主**
- **防闪烁**：逐字延长输入走增量快路径，建议不重算、不跳动（fish shell 套路）

## 快速开始（一键安装）

```bash
opencode plugin add github:dubuqiangu/opencode-history-ghost
```

装完**必须完整重启 TUI**（`/reload` 不会重载插件本体，只会留下重复死实例）。

交给 AI 代装也可以：直接对 OpenCode 说「请按
`https://github.com/dubuqiangu/opencode-history-ghost` 的 README 安装这个插件」，
它会读取本文件并完成配置与重启引导。

- **更新**：`opencode plugin update github:dubuqiangu/opencode-history-ghost`（**更新后同样必须完整重启 TUI**）。
- **卸载**：`opencode plugin remove github:dubuqiangu/opencode-history-ghost`；插件不留任何残留（历史数据本就属于宿主）。

> 本插件通过 GitHub 一键安装，**不引用、也不要求用户创建任何本地源码路径**。仓库根目录的 `index.ts` / `tui.js` 只是给目录式 `Host.resolve` 的入口桥接，`dist/tui.js` 随仓库交付——`package.json` 的 `exports["."]` → `src/index.ts`、`exports["./tui"]` → `./dist/tui.js`，用户无需关心这些内部路径。

## 功能一览

| 功能 | 入口 | 说明 |
|---|---|---|
| 灰字实时建议 | 输入 ≥3 字符（可配） | 优先在输入框内、光标之后显示灰色内联后缀；无法内联时降级为输入框正上方一行灰显建议；逐字延长走增量快路径防闪烁 |
| 接受建议 | `Tab`（可配） | 仅以光标前文本匹配，接受时整句替换当前输入（包括光标后内容），接受后光标落在整句末尾 |
| 候选循环 | `ctrl+↓` / `ctrl+↑` | 在匹配候选间切换，提示行显示 `(n/5)` 计数 |
| 消除建议 | `Esc` | 同一输入不再重现，继续输入即恢复 |
| 总开关 | 命令面板 → "History Ghost: 开关历史建议" | 含 toast 反馈；设置持久化于 OpenCode durable storage（键 `history-ghost-settings`），跨实例同步、重启保留 |
| 历史数据源 | 常驻后台（只读） | `opencode.db`（SQLite，全量用户消息，上限 2000 条）+ `~/.local/state/opencode/prompt-history.jsonl`（3 秒轮询增量合并，弥补"本次会话刚提交的 prompt 尚未入库"）；匹配分层前缀 > 子串 > fuzzy，档内最新优先 |
| 与内置补全互斥 | 自动 | `@` / `/` 触发的宿主补全弹窗激活时，建议快捷键层失效，`Tab` 归还宿主；无绑定按键的命令面板总开关在独立全局层，关掉建议、无候选或 composer 未聚焦时仍可使用 |

历史源合并优先级为 **jsonl > V2 `session_message` > legacy `message`/`part`**；各源内部最新在前，跨来源不比较不同时间基准的时间戳，去重并截断到 2000 条。这是排序规则，不代表三个来源都已在当前宿主真机确认。

**编辑器身份保护**：只对当前 session 路由下、能由 `prompt.footer` marker 沿私有 Prompt 树结构唯一证明的 composer textarea 给出建议并操作按键；无法证明身份的对话框、权限输入、未知树结构或路由一律 fail-closed，不以旧编辑器是否销毁猜测新焦点身份。该适配器依据 OpenCode v2.0.29 的私有树结构实现，**代码目前未校验宿主版本号**，版本变化可能让建议安全停用；真实 renderer 的模拟结构回归不是宿主 TUI 父子链验收。

## 配置

默认值（DESIGN §3.8）：

| 配置项 | 默认值 | 说明 |
|---|---|---|
| `enabled` | `true` | 总开关；可用命令面板 "History Ghost: 开关历史建议" 切换 |
| `acceptKey` | `"tab"` | 接受建议的按键，可配 `"right"`、`"ctrl+y"` 等 |
| `minChars` | `3` | 触发建议的最小输入长度（trim 后计） |
| `maxCandidates` | `5` | 每次评估保留的候选上限 |
| `maxEntries` | `2000` | 从数据源加载的历史条数上限。仅插件启动时生效，运行期修改不热加载（重启 TUI 后生效） |
| `maxTextLength` | `2000` | 超长文本（如粘贴内容）不进入历史建议。仅插件启动时生效，运行期修改不热加载（重启 TUI 后生效） |
| `excludePrefixes` | `["/", "@"]` | 命中任一前缀不出建议（宿主命令/引用域） |

按键约定：

| 按键 | 动作 |
|---|---|
| `Tab`（可配） | 接受建议，整句替换当前输入（接受后光标落在整句末尾） |
| `ctrl+↓` / `ctrl+↑` | 切换下一条 / 上一条候选 |
| `Esc` | 取消当前建议；同一输入不再重现，继续输入即恢复 |
| 命令面板 → "History Ghost: 开关历史建议" | 总开关（含 toast 反馈） |

## 排障

1. 安装后**完整重启 TUI**，输入一段历史里出现过的前缀（≥3 字符）：输入框**内、光标之后**应出现灰色内联后缀，或在输入框**上方**出现灰显幽灵行（内联无法定位时的降级形态）。
2. 常见症状：
    - **不出建议**：确认光标前输入 ≥3 字符、不以 `/` 或 `@` 开头、历史里确有匹配；
     DB 打不开或 schema 变化时自动降级为 jsonl-only（日志中有一次性 warn，功能不断）。
    - **建议不刷新**：已确认缺陷是历史源 `whenReady()` 或 jsonl mtime 刷新后，若输入未变化，现有候选不会自行重新评估；预期在可信 composer 上仅于历史实际变化时重评估当前输入。`Esc` 对同一输入的压制仍须保持，不因历史刷新重新弹出。jsonl 轮询间隔为 3 秒，但不保证届时真实 TUI 已刷新。
    - **编辑器失焦后 hook 失效**：仅在当前路由与 footer marker 结构唯一证明新 composer 身份时，1.5 秒身份轮询才会重挂；未知结构保持停用，不会按编辑器销毁状态自动采纳。
3. 需要宿主日志时过滤 `~/.local/share/opencode/log/opencode.log`：
   ```bash
   grep 'role=cli' ~/.local/share/opencode/log/opencode.log | grep history-ghost
   ```
   注意：上游取证表明**插件侧 `console.*` 输出未必进入宿主日志**，此通道不一定有内容（见 `docs/tui-plugin-pitfalls.md` 第 13 条）。

## 已知限制

1. **框内内联覆盖层**已按 absolute 覆盖层方案实现（`session.composer.top` 上的 0 尺寸 anchor + 内嵌绝对定位 `<text>`），并在真实 `TextareaRenderable` 冒烟测试中确认能绘入字符帧；但**当前宿主真机验收中灰色建议仍显示在输入框上方**——内联路径未生效时自动降级为上方幽灵行，根因待真机诊断（宿主 slot 的兄弟层级 / zIndex 遮挡或几何假设待定）。降级路径是可靠保底。
2. CJK 宽字符按 code units 截断（每行 100 units），极端情况视觉宽度不精确。
3. 历史含敏感信息时，建议同样可见于屏幕（历史来自本机 DB，不外发；v1 不做 secret 过滤）。
4. fuzzy 档只对截断后的历史（≤2000 条）保证，且阈值策略与宿主内置补全的 fuzzysort 用法不同。
5. **composer 身份依赖私有结构**：基于 v2.0.29 Prompt 树 `prompt.footer` marker 的结构适配器
   仅接受当前 session 路由下唯一可证明的 textarea；未知树、路由或身份 fail-closed，
   不自动给对话框建议，也不劫持其 Tab/Esc。当前实现**没有宿主版本号门槛**；
   宿主升级后的树结构兼容性未知，真实 renderer 模拟测试尚未验证宿主 TUI 的实际父子链，
   必须完成 T11/T12 人工验收才能声称真实宿主安全及可用。
6. 若终端复用器（tmux/screen 等）不区分 ctrl+方向键与普通方向键（两者混同），
    候选循环切换将不可用，其余功能不受影响。
7. 光标处于中间时只以光标前文本匹配（例如 `abc|XYZ` 匹配 `abcdef`，Tab 后全文为 `abcdef`，光标落在末尾）；SDK 显示单元偏移不能可靠转换为文本边界时安全停用建议，不按 JS 字符索引猜测。该行为已在真实 OpenTUI 测试 renderer 中覆盖 Unicode/多行，真实宿主 T11/T12 仍待人工验收。
8. **开发期诊断探针**（`src/probe-log.ts` / `src/context-probe.ts`）会在插件根目录写入 `probe-*.txt` 诊断文件；它们属于开发脚手架，**发布前应整体移除**（当前源码仍保留，用于定位真机内联覆盖层问题）。

## 隐私说明

- 历史数据**仅在本机读取**（`opencode.db` 只读打开 + 本机 jsonl），不做任何网络外发。
- 匹配全部在进程内内存中完成，无 IPC、无第三方服务。
- 开发冒烟脚本（`scripts/dev-smoke.ts`）候选文本以 `***` 全掩码，仅输出计数与长度，绝不打印任何明文片段。

## 开发

- **发布前必须**运行 `npm run build:tui`，将生成的 `dist/tui.js` 随包交付。项目选定的 OpenTUI 模式冲突应对方式是将本地业务模块打成**单文件**，`@opentui/*`、`solid-js` 和宿主 SDK 保持 external，由宿主提供而不是随包再安装一份。`package.json` 的 `./tui` export 指向 `./dist/tui.js`；根级 `tui.js` 给目录式 `Host.resolve` 做 `export { default } from "./dist/tui.js"` 桥接，两条路径落到同一产物。**任意 `src/` 改动均须重新构建 `dist/tui.js` 并重跑交付测试**，否则旧 bundle 可能仍被实际加载；下面的 graph-check 临时文件**不是**发布产物。`bun:sqlite` 的动态加载是 Bun 运行时合法形式，不要当作未打包的本地业务模块。静态回归不证明真实宿主能解析 external 或共享同一 OpenTUI/Solid 实例，真实 TUI 内联灰字仍未定因，T11/T12 尚未通过。
- 可做入口 TSX 语法转换（**无 `--bundle`，不遍历完整导入图**；插件根目录执行，零报错为准）：
  ```bash
  npx esbuild src/tui.tsx --loader:.tsx=tsx --jsx=automatic --log-level=error
  ```
- 本地依赖图构建检查（把宿主提供的 SDK 与 Node 内建模块列为 external；只验证本地导入解析/转换，**不**验证 external 运行时可用、实际宿主解析或构造器是否共享）：
  ```bash
  npx esbuild src/tui.tsx --bundle --platform=node --loader:.tsx=tsx --jsx=automatic --external:@opentui/core --external:@opentui/solid --external:@opencode/plugin --external:node:* --log-level=error --outfile=history-ghost-graph-check.js
  # 检查退出码后删除临时产物 history-ghost-graph-check.js（无需安装/加载该 bundle）
  ```
- 开发冒烟（尝试读取本机 DB，打不开可降级 jsonl-only；候选全掩码）：
  ```bash
  bun scripts/dev-smoke.ts                    # DB 只观测；合成 2000 条三桶稳态 p95 <1ms 失败则 exit 1
  bun scripts/dev-smoke.ts --require-real-db  # 显式要求 DB 成功加载；无 DB 或不可读会 FAIL、exit 1
  npx tsx scripts/dev-smoke.ts                # Node 路径；同样检查退出码与 PASS/FAIL
  ```
- 一键安装自验证（发布 / 维护者；**github 模式会执行 `plugin update`、更改宿主安装，须先获许可**）：
  ```bash
  pwsh scripts/verify-install.ps1 -Mode github   # 运行 plugin update，更改宿主安装；须先获许可
  pwsh test/verify-install.test.ps1              # 脚本判据的静态负例测试（不触碰真实宿主）
  ```
  脚本分进程运行十一项独立 Bun 回归（`ghost-core`、`editor-bridge-regression`、`tui-load-diagnostic`、`caret-prefix-accept`、`history-completeness`、`ghost-remount`、`composer-identity`、`history-scan-performance`、`entry-resolution`、`tui-delivery`、`history-reassessment`），检查退出码及 PASS/FAIL；**不可合并为一条 Bun 测试进程**（模块 mock 会串扰）。交付回归静态检查实际发布文件 `dist/tui.js`（不是 graph-check）、external import 和根级桥接；github 模式按 `plugins` 数组精确匹配 ID，并逐一比对已安装 `src/`、`scripts/` 对应的 git tracked 文件路径与 SHA256，另比对 stamp 中 bundle 与桥接的哈希。这些自动检查**不能代替**重启 TUI 后的人工验收。
- 更多 TUI 插件坑记录见 [`docs/tui-plugin-pitfalls.md`](docs/tui-plugin-pitfalls.md)。

最新复核无新增 P0/P1：B1（后缀文本/位置同源）、B2（软换行改用 `visualCursor`）等已在源码修复并有回归覆盖，P2 双份加载经独立复审判定**非阻塞**（TUI 进程只加载 `.tui` 入口，server 入口无 `ui.slot` 时提前返回）。**仍待完成**：真机框内内联覆盖层验收（当前降级为上方幽灵行，根因未定）、T11/T12 人工验收；并发 WAL 跨页扫描不保证同一快照，真实 DB 与宿主流畅度尚未验证。

## License

MIT © OpenCode History Ghost Contributors
