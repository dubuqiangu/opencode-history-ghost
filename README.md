# opencode-history-ghost

[OpenCode](https://opencode.ai) V2 TUI 插件：在输入框打字时基于**本机历史输入**给出"幽灵行"灰字建议——最匹配的一条显示在输入框**正上方**，已输入部分正常色、建议后缀灰显，按 `Tab` 即用整句替换当前输入。

```
┌──────────────────────────────────────────────────────────────┐
│ 帮我写一个 解析 CSV 的 Python 脚本  Tab 接受 · (1/5) ctrl+↑↓ 切换 · Esc 取消 │ ← 幽灵行（灰显建议，非输入内容）
├──────────────────────────────────────────────────────────────┤
│ > 帮我写一个                                          ▍      │ ← 输入框（▍为光标）
└──────────────────────────────────────────────────────────────┘
```

- **亚毫秒匹配**：纯内存三层匹配（前缀 > 子串 > fuzzy，与宿主内置补全同款 fuzzysort 引擎），实测单次匹配 0.004–0.117ms（2026-10-16 冒烟实测，以 `scripts/dev-smoke.ts` 输出为准）
- **仅本机数据零外发**：历史只读本机 `opencode.db` 与 `prompt-history.jsonl`，不做任何网络上行，无 IPC、无第三方服务
- **静默降级**：DB 打不开或 schema 不适配时自动降级 jsonl-only（日志一次性 warn），主功能不断、**绝不崩溃宿主**
- **防闪烁**：逐字延长输入走增量快路径，建议不重算、不跳动（fish shell 套路）

## 快速开始

三种安装方式任选其一；**装完必须完整重启 TUI**（`/reload` 不会重载插件）。

### 方式一：file:// 本地挂载（当前推荐，即装即用）

在 `~/.config/opencode/opencode.json` 中显式挂载（改前先备份）：

```json
{
  "plugins": ["file:///D:/your/path/to/opencode-history-ghost"]
}
```

> 路径按实际仓库位置调整；Windows 下用 `file:///D:/...` 三斜杠形式。
> 改完重启 TUI 生效。卸载：移除该条目并重启，插件不留任何残留（历史数据本就属于宿主）。

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

安装是否到位可一键自检：`pwsh scripts/verify-install.ps1`（file:// 本地模式；发布后加 `-Mode github` 走发布链验证），全部 PASS 才算装好。

## 功能一览

| 功能 | 入口 | 说明 |
|---|---|---|
| 幽灵行实时建议 | 输入 ≥3 字符（可配） | 输入框正上方灰显建议行；逐字延长走增量快路径防闪烁 |
| 接受建议 | `Tab`（可配） | 整句替换当前输入 |
| 候选循环 | `ctrl+↓` / `ctrl+↑` | 在匹配候选间切换，行尾显示 `(n/5)` 计数 |
| 消除建议 | `Esc` | 同一输入不再重现，继续输入即恢复 |
| 总开关 | 命令面板 → "History Ghost: 开关历史建议" | 含 toast 反馈；设置持久化于 OpenCode durable storage（键 `history-ghost-settings`），跨实例同步、重启保留 |
| 历史数据源 | 常驻后台（只读） | `opencode.db`（SQLite，全量用户消息，上限 2000 条）+ `~/.local/state/opencode/prompt-history.jsonl`（3 秒轮询增量合并，弥补"本次会话刚提交的 prompt 尚未入库"）；匹配分层前缀 > 子串 > fuzzy，档内最新优先 |
| 与内置补全互斥 | 自动 | `@` / `/` 触发的宿主补全弹窗激活时，本插件的按键层整体失效，`Tab` 归还宿主 |

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
   - **不出建议**：确认输入 ≥3 字符、不以 `/` 或 `@` 开头、光标在行尾、历史里确有匹配；
     DB 打不开或 schema 变化时自动降级为 jsonl-only（日志中有一次性 warn，功能不断）。
   - **建议不刷新**：刚提交的 prompt 最多延迟 3 秒（jsonl mtime 轮询）进入候选池。
   - **编辑器失焦后 hook 失效**：宿主重建输入框后由 1.5 秒身份轮询自动重挂，最多延迟 1.5 秒。

## 已知限制

1. 灰字显示在输入框**上方一行**而非框内原生内联（V2 API 硬限制；上游 OpenTUI 的
   "inline ghost suffix" 是唯一无损升级路径）。
2. CJK 宽字符按 code units 截断（每行 100 units），极端情况视觉宽度不精确。
3. 历史含敏感信息时，建议同样可见于屏幕（历史来自本机 DB，不外发；v1 不做 secret 过滤）。
4. fuzzy 档只对截断后的历史（≤2000 条）保证，且阈值策略与宿主内置补全的 fuzzysort 用法不同。
5. **对话框输入防劫持是启发式的**：插件以"旧输入框实例是否已被宿主销毁"区分重建的
   composer 与对话框输入（对话框打开时旧实例存活 → 拒绝跟进焦点）。若宿主在未来版本
   改为"不销毁旧实例直接换新输入框"，建议会安全停用（宁缺勿劫持），Tab/Esc 也不再
   被消费；另有 run 级文本一致性校验兜底 1.5 秒轮询竞态窗口。极小概率的首挂载窗口内
   （插件加载的瞬间恰好有对话框聚焦），该对话框会被临时误认为 composer（可能出现建议、
    Tab 可能改写对话框内容）；对话框关闭后自动恢复正确识别，重启即彻底消除。
6. 若终端复用器（tmux/screen 等）不区分 ctrl+方向键与普通方向键（两者混同），
   候选循环切换将不可用，其余功能不受影响。

## 隐私说明

- 历史数据**仅在本机读取**（`opencode.db` 只读打开 + 本机 jsonl），不做任何网络外发。
- 匹配全部在进程内内存中完成，无 IPC、无第三方服务。
- 开发冒烟脚本（`scripts/dev-smoke.ts`）候选文本以 `***` 全掩码，仅输出计数与长度，绝不打印任何明文片段。

## 开发

- 源码经 OpenCode 运行时解析，无需构建；改动后做语法校验（插件根目录执行，零报错为准）：
  ```bash
  npx esbuild src/tui.tsx --loader:.tsx=tsx --jsx=automatic --log-level=error
  ```
- 开发冒烟（真实本机 DB，候选全掩码）：
  ```bash
  bun scripts/dev-smoke.ts        # bun:sqlite 主路径，应全部 PASS
  npx tsx scripts/dev-smoke.ts    # node:sqlite 降级路径，应全部 PASS
  ```
- 一键安装自验证（详见各检查项的 PASS/FAIL 输出）：
  ```bash
  pwsh scripts/verify-install.ps1                # file:// 本地模式（默认）
  pwsh scripts/verify-install.ps1 -Mode github   # 发布链模式（发布后用）
  ```

## License

MIT © OpenCode History Ghost Contributors
