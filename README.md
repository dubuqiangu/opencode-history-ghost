# opencode-history-ghost

[OpenCode](https://opencode.ai) V2 TUI 插件：在输入框打字时基于**本机历史输入**给出"幽灵行"灰字建议——最匹配的一条显示在输入框**正上方**，已输入部分正常色、建议后缀灰显，按 `Tab` 即用整句替换当前输入。

```
┌──────────────────────────────────────────────────────────────┐
│ 帮我写一个 解析 CSV 的 Python 脚本  Tab 接受 · (1/5) ctrl+↑↓ 切换 · Esc 取消 │ ← 幽灵行（灰显建议，非输入内容）
├──────────────────────────────────────────────────────────────┤
│ > 帮我写一个                                          ▍      │ ← 输入框（▍为光标）
└──────────────────────────────────────────────────────────────┘
```

- **内存匹配**：三层匹配（前缀 > 子串 > fuzzy，与宿主内置补全同款 fuzzysort 引擎）。`dev-smoke.ts` 以 2000 条非个人合成历史分别覆盖三桶，预热后每桶测两轮各 101 次 `findCandidates`，取较快轮 p95，断言 **<1ms/次**；仅覆盖匹配函数，不含加载、渲染及 I/O，也不保证每次调用都低于 1ms。
- **仅本机数据零外发**：历史只读本机 `opencode.db` 与 `prompt-history.jsonl`，不做任何网络上行，无 IPC、无第三方服务
- **静默降级**：DB 打不开或 schema 不适配时自动降级 jsonl-only（日志一次性 warn），主功能不断、**绝不崩溃宿主**
- **防闪烁**：逐字延长输入走增量快路径，建议不重算、不跳动（fish shell 套路）

## 快速开始

三种安装方式任选其一；**装完必须完整重启 TUI**（`/reload` 不会重载插件）。

### 方式一：file:// 本地挂载（本地源码开发可选）

本地开发时，先备份再分别在服务端 `~/.config/opencode/opencode.json` 与 **v2 TUI** `~/.config/opencode/cli.json` 的 `plugins` 数组中临时挂载同一仓库 file URI；仅修改服务端配置不能证明 TUI 已安装：

```json
{
  "plugins": ["file:///D:/your/path/to/opencode-history-ghost"]
}
```

> 路径按实际仓库位置调整；Windows 下用 `file:///D:/...` 三斜杠形式。
> 上述 JSON 片段须分别加入两个文件（保留各文件其他现有配置及插件项）。改完重启 TUI 生效。卸载：从两个文件移除临时条目并重启，插件不留任何残留（历史数据本就属于宿主）。正式 GitHub 安装方式见下方，不需要改为 file URI。

**根目录入口注意**：上例 URI 指向仓库根目录。`package.json` 的 `exports["."]` / `exports["./tui"]` 指向 `src/index.ts` / `src/tui.tsx`，但本地 SDK 的 `Host.resolve({ directory: repoRoot })` 对目录目标查找根目录 `index` / `tui`，不会因 src 导出存在便自动找到入口；两份配置都登记成功也**不等于入口可解析**。根级桥接入口应存在且可由该解析器查到。此说明不建议把 URI 改成 `src`，也不改变正式 GitHub 安装方式。

**真机阻塞（尚未修复）**：根级入口补齐后，TUI 已进入插件加载阶段，但报 OpenTUI 重复环境变量 `OPENTUI_FORCE_UNICODE`（现有 mode2026 与新 mode2027 冲突）。这不是入口可用的证据，当前不能声称插件在真实宿主可用；依赖导入与实例兼容问题由父代理继续排查。不要为使自检 PASS 修改宿主配置。

### 方式二：交给 AI 代装（发布后）

```
opencode plugin add github:dubuqiangu/opencode-history-ghost
```

AI 代装路径：直接对 OpenCode 说"请按
`https://github.com/dubuqiangu/opencode-history-ghost` 的 README 安装这个插件"，
它会读取本文件并完成配置修改与重启引导。

### 方式三：git clone 到全局插件目录（发布后）

```bash
git clone https://github.com/dubuqiangu/opencode-history-ghost.git \
  ~/.config/opencode/plugins/opencode-history-ghost
cd ~/.config/opencode/plugins/opencode-history-ghost
npm install
```

克隆到 `~/.config/opencode/plugins/` 下后重启 TUI 即自动加载。

**更新方式**：file:// 挂载下改源码后重启 TUI 即生效；github: 安装用
`opencode plugin update github:dubuqiangu/opencode-history-ghost`（**更新后必须完整重启 TUI**）。

按实际安装来源选择验证模式：`pwsh scripts/verify-install.ps1` 默认要求服务端 `opencode.json` **及 v2 TUI `cli.json`** 各自 `plugins` 数组包含指向当前现存仓库的 file URI；缺少任一项即 FAIL，并单独调用本地 `@opencode/plugin` 的 `Host.resolve({directory: repoRoot})` 判定 server/tui 两个根入口可解析（只解析不加载插件）。当前宿主若以 GitHub 安装，file 注册项必然 FAIL，切勿为了获得 PASS 修改宿主配置；`-Mode github` 会执行 `opencode plugin update` 并修改已安装插件，只有得到更新许可后才能运行。脚本分别进程运行十一项 Bun 回归（含 `history-reassessment`、`entry-resolution`、`tui-delivery`、`tui-load-diagnostic`、`caret-prefix-accept`）与本地冒烟；入口解析检查仅证明入口可定位，交付回归只静态检查实际 `dist/tui.js` 及根级桥接，并不执行 TUI。即使全部 PASS，也不等于宿主 TUI 可用或真实 DB 已验证。解析实测使用本仓库本地 plugin SDK 2.0.29；参考宿主源码为 2.0.26，不能外推为宿主 v2.0.32 真机已成功。

## 功能一览

| 功能 | 入口 | 说明 |
|---|---|---|
| 幽灵行实时建议 | 输入 ≥3 字符（可配） | 输入框正上方灰显建议行；逐字延长走增量快路径防闪烁 |
| 接受建议 | `Tab`（可配） | 仅以光标前文本匹配，接受时整句替换当前输入（包括光标后内容） |
| 候选循环 | `ctrl+↓` / `ctrl+↑` | 在匹配候选间切换，行尾显示 `(n/5)` 计数 |
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
| `Tab`（可配） | 接受建议，整句替换当前输入 |
| `ctrl+↓` / `ctrl+↑` | 切换下一条 / 上一条候选 |
| `Esc` | 取消当前建议；同一输入不再重现，继续输入即恢复 |
| 命令面板 → "History Ghost: 开关历史建议" | 总开关（含 toast 反馈） |

## 排障

1. 安装后重启 TUI，输入一段历史里出现过的前缀（≥3 字符），输入框上方应出现灰显幽灵行。
2. 日志排查：`~/.local/share/opencode/log/opencode.log`，过滤 `role=cli`：
   ```bash
   grep 'role=cli' ~/.local/share/opencode/log/opencode.log | grep history-ghost
   ```
   本插件所有异常都以 `console.warn` 前缀 `[opencode-history-ghost]` 落入该日志，且**绝不崩溃宿主**。
3. 常见症状：
    - **不出建议**：确认光标前输入 ≥3 字符、不以 `/` 或 `@` 开头、历史里确有匹配；
     DB 打不开或 schema 变化时自动降级为 jsonl-only（日志中有一次性 warn，功能不断）。
    - **建议不刷新**：已确认缺陷是历史源 `whenReady()` 或 jsonl mtime 刷新后，若输入未变化，现有候选不会自行重新评估；预期在可信 composer 上仅于历史实际变化时重评估当前输入。`Esc` 对同一输入的压制仍须保持，不因历史刷新重新弹出。jsonl 轮询间隔为 3 秒，但不保证届时真实 TUI 已刷新。
    - **编辑器失焦后 hook 失效**：仅在当前路由与 footer marker 结构唯一证明新 composer 身份时，1.5 秒身份轮询才会重挂；未知结构保持停用，不会按编辑器销毁状态自动采纳。

## 已知限制

1. 灰字显示在输入框**上方一行**而非框内原生内联（V2 API 硬限制；上游 OpenTUI 的
   "inline ghost suffix" 是唯一无损升级路径）。
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
7. 光标处于中间时只以光标前文本匹配（例如 `abc|XYZ` 匹配 `abcdef`，Tab 后全文为 `abcdef`）；SDK 显示单元偏移不能可靠转换为文本边界时安全停用建议，不按 JS 字符索引猜测。该行为已在真实 OpenTUI 测试 renderer 中覆盖 Unicode/多行，真实宿主 T11/T12 仍待人工验收。

## 隐私说明

- 历史数据**仅在本机读取**（`opencode.db` 只读打开 + 本机 jsonl），不做任何网络外发。
- 匹配全部在进程内内存中完成，无 IPC、无第三方服务。
- 开发冒烟脚本（`scripts/dev-smoke.ts`）候选文本以 `***` 全掩码，仅输出计数与长度，绝不打印任何明文片段。

## 开发

- **发布前必须**运行 `npm run build:tui`，将生成的 `dist/tui.js` 随包交付。项目选定的 OpenTUI 模式冲突应对方式是将本地业务模块打成**单文件**，`@opentui/*`、`solid-js` 和宿主 SDK 保持 external，由宿主提供而不是随包再安装一份。`package.json` 的 `./tui` export 指向 `./dist/tui.js`；根级 `tui.js` 给目录式 `Host.resolve` 做 `export { default } from "./dist/tui.js"` 桥接，两条路径落到同一产物。**任意 `src/` 改动均须重新构建 `dist/tui.js` 并重跑交付测试**，否则旧 bundle 可能仍被实际加载；下面的 graph-check 临时文件**不是**发布产物。`bun:sqlite` 的动态加载是 Bun 运行时合法形式，不要当作未打包的本地业务模块。静态回归不证明真实宿主能解析 external 或共享同一 OpenTUI/Solid 实例，真实 TUI 灰字缺席仍未定因，T11/T12 尚未通过。
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
- 一键安装自验证（详见各检查项的 PASS/FAIL 输出）：
  ```bash
   pwsh scripts/verify-install.ps1 -Mode file      # 两份配置都以 file:// 指向当前仓库时使用；仅服务端注册会 FAIL
  pwsh test/verify-install.test.ps1               # 无宿主更新的脚本判据负例测试
  # pwsh scripts/verify-install.ps1 -Mode github  # 会运行 plugin update，更改安装；须先获许可
  ```
    file 模式另外分别检查入口 TSX 转换和 SDK/Node 外置的本地依赖图构建，不能将前者的 PASS 当作完整打包或宿主加载成功。两模式均分别运行十一项独立 Bun 回归：`bun test/ghost-core.test.ts`、`bun test/editor-bridge-regression.test.ts`、`bun test/tui-load-diagnostic.test.ts`、`bun test/caret-prefix-accept.test.ts`、`bun test/history-completeness.test.ts`、`bun test/ghost-remount.test.ts`、`bun test/composer-identity.test.ts`、`bun test/history-scan-performance.test.ts`、`bun test test/entry-resolution.test.ts`、`bun test test/tui-delivery.test.ts`、`bun test test/history-reassessment.test.ts`（最后三项采用 Bun test runner），检查退出码及 PASS/FAIL；不可合并为一条 Bun 测试进程（核心测试的模块 mock 会串扰）。交付回归检查实际发布文件 `dist/tui.js`（不是仅检查 graph-check）、external import 和根级桥接；GitHub 模式按 `plugins` 数组精确匹配 ID，并逐一比对已安装 `src/`、`scripts/` 对应的 git tracked 文件路径与 SHA256，另比对 stamp 中 bundle 和桥接与本地交付文件的哈希；若本地 dist 未随发布进入仓库/安装包，会 FAIL。这些自动检查不能代替重启 TUI 后的人工验收。冒烟打印 DB 成功加载次数、合并条目数；合并数**不是** DB 独立条目数，DB 缺失时显示「未验证」而非「真实 DB PASS」。如需把真实 DB 可读纳入验收门槛，另行运行上面的 `--require-real-db`；匹配 p95 不是宿主真实 DB/渲染的性能证明。

最新复核无新增 P0/P1，可安排受控宿主 TUI 验收，但 **T11/T12 仍未完成**：v2.0.29 仅是私有 Prompt 树结构的参考，不是代码已实施的宿主版本门槛；真实宿主是否共享 OpenTUI 构造器、footer marker 父子链是否符合模拟测试均待确认。高重复历史下同步 OFFSET 分页的启动阻塞 P2 已用绑定 keyset 分页（V2 `(time_created,rowid)`、legacy 三元 tuple；NULL 时间单独扫描，NULL 续页用 `(message.rowid,part.rowid) < (?,?)`）及每页 `setImmediate` 让出缓解。oracle SQL 代码级复核未发现静态库遗漏/重复、NULL 阶段或 Node 接口问题；性能测试分别覆盖 112k 行合成大库与 60k 消息/120001 parts 的 NULL 时间夹具，后者本机观测旧 8.7s→新 136ms，**不是性能保证**。此前六项独立 Bun 回归、双运行时 smoke 和 PS 负例曾通过；后续八项独立 Bun 回归及双配置 file 模式、PS 负例曾通过，但那时尚未判根目录入口是否可解析；本轮九项及 Host.resolve 校验、PS 负例和 file 模式已通过（仅本地 SDK 2.0.29，不是 v2.0.32 宿主真机验证）；并发 WAL 跨页扫描不保证同一快照（新插入的更晚行可能不收、旧行可能收），非 NULL 单消息海量 parts 与无索引单页仍可能阻塞；真实 DB 和宿主流畅度尚未验证。

## License

MIT © OpenCode History Ghost Contributors
