# OpenCode V2 TUI 插件开发避坑清单（opencode-history-ghost 实证）

本清单来自 `opencode-history-ghost` 从"按键全灭 + 灰字看不见"到真机快捷键全部生效的调试过程，以及一轮独立复审（@oracle）。面向所有写 `@opencode/plugin/tui` + `@opentui/solid` 的开发者，按"会让你调一下午"的程度排序。每条尽量给出 症状 / 根因 / 正确姿势 / 涉及文件。

---

## 1. keymap layer 的 `target` / `enabled` 被宿主一次性解析——为 null 时整层被移除（按键全灭的根因）

**症状**：插件注册了快捷键 layer，代码审查看完全正确，真机却一个键都不触发；所有快捷键"全灭"。

**根因**：宿主对 layer 级 `target`（返回当前应接受按键的编辑器）只解析一次，并把结果当作静态条件。注册当时 `target()` 返回 null（例如身份尚未证明、编辑器还没聚焦），整个 layer 就被判为无效并移除；之后 target 变有效也不会自动回来。

**正确姿势**：**不要在 layer 级放 `target` / `enabled`**。layer 始终注册，把"身份是否可信 / 有无候选 / 开关是否开启"的判定放进**每个命令的 `run()` 内**，每次按键都重新判定；不满足就 `return false` 把按键归还宿主。

涉及：`src/keymap.ts`。

---

## 2. slot render 是正常流布局，不是浮层——`position:absolute` 子节点会落到屏幕外（"灰字看不见"的根因）

**症状**：用 `append:"app"` slot + `position:absolute` 挂覆盖层，灰字出现在底部 / 屏幕外 / 被裁掉；换到目标区域 slot 才正常。

**根因**：slot render 返回的根节点按**正常流**参与布局，`absolute` 子节点相对该父盒定位。`app` 容器在布局中的正常流位置在**主列底部**，所以"绝对定位"其实锚在了屏幕底部附近，而不是你想要的输入框。

**正确姿势**：
- anchor 挂到**目标区域自己的 slot**（本例 `session.composer.top`）：根节点是 **0 尺寸的正常流盒**，它的屏幕原点就等于该区域原点；真正要画的东西放进它的**内嵌绝对定位子节点**，`left/top` 相对 anchor 计算。
- Box / `Renderable` 默认 `overflow: "visible"`，**0 尺寸 anchor 不会裁剪**它的绝对子节点。
- slot render 返回**单个** `JSX.Element`：裸文本要包 `<text>`，`null` 表示不渲染。
- 同一路径允许**多个独立 claim**（宿主对 `slots.register(path)` 计数）；但它们挂在不同子树，绘制顺序是 claim 顺序而非源码顺序。

> **宿主限制警告（真机探针证据）**：本插件当初正是据此方案在 `session.composer.top` 上做 0 尺寸
> anchor + 内嵌绝对定位 `<text>` 画框内内联后缀。但**真机探针证明当前 opencode 宿主忽略嵌套文本框上的
> `position:absolute` `left/top` 写入**：写 `top=1` 后重读节点 `screenY` 仍停在 anchor 行（18 次
> `bounds=mismatch`），节点从未落到 textarea 行。故该"0 尺寸 anchor + 绝对子节点"技术**在当前宿主上
> 对嵌套文本框不可靠**，框内内联覆盖层不可用；插件已改以输入框正上方一行幽灵建议为部署表面。
> 几何契约本身仍成立（作为设计意图），但真机定位被宿主忽略。若未来宿主尊重绝对定位可重试。

涉及：`src/ghost-overlay-render.tsx`。

---

## 3. `editor.cursorOffset` 是"显示格"，不是 JS 码元——`plainText.slice(0, offset)` 会劈开宽字符

**症状**：纯 ASCII 正常，一遇到中文 / emoji 就取错光标前文本，覆盖层判 null 或画到错误的格子。

**根因**：`cursorOffset`（= `visualCursor.offset`）单位是**屏幕显示格**：CJK 一个字符占 2 格、ZWJ emoji 一个簇占 2 格；而 `String.prototype.slice` 用 UTF-16 码元。两者对非 ASCII 没有对应关系。

**正确姿势**：用 SDK 的 buffer 按显示格取真实前缀 `editBuffer.getTextRange(0, cursorOffset)`；再由前缀用 `stringWidth`（东亚宽度感知）反推光标格。**不要**用 `plainText.slice(0, offset)` 当后备——那条路径只在没有 buffer 的假编辑器上才安全。

涉及：`src/ghost-overlay-render.tsx`（`resolveCaretPrefixText` / `caretCellFromPrefix`）、`src/string-width.ts`。

---

## 4. composer 会软换行，但 `logicalCursor` 是文档绝对坐标——长行定位错

**症状**：单行很长时覆盖层不出现，或跑到错误的可见行。

**根因**：`EditBufferRenderable` 默认 `wrapMode: "word"`，宿主 composer 没有覆盖它 → 输入框会**软换行**。`logicalCursor` 是**文档绝对**行列，`logicalCursor − scroll` 并不等于屏幕格。另外真机编辑器**没有** `textBufferView` 属性（真属性是 `editorView`），所以读 `textBufferView.scrollX` 得到的水平滚动**恒为 0**。

**正确姿势**：优先用原生**视口相对**的 `visualCursor.visualRow/visualCol`（换行与滚动已经算进去），完全不需要自己做 scroll 减法；把 `logicalCursor − scroll` 仅留作没有 `visualCursor` 时的后备。

涉及：`src/ghost-overlay.tsx`（`resolveOverlayGeometry`）。

---

## 5. 后缀的"文本"和"位置"必须同源——两个光标字段会分歧

**症状**：偶发在错误的格子上画另一段文本的尾巴，或该显示时判 null。

**根因**：文本来自 `cursorOffset`（经 `editBuffer` 切片），位置来自 `logicalCursor`——**两个不同的字段**。在滚动 / 换行边界它们可以指向不同的字符。而"前缀 + 后半段 === 全文"这类完整性校验对**任何**合法边界都成立，**校验不出**两个字段是否一致。

**正确姿势**：让后缀文本和后缀起始格**从同一个权威前缀派生**（同一前缀 → 文本；同一前缀 → 光标格）。不要一条路径用一个字段取文本、另一个字段取位置。

涉及：`src/ghost-overlay-render.tsx`（`planInlineRender`）。

---

## 6. 增量快路径的判据必须覆盖全部候选，且列表未截断

**症状**：逐字延长输入时用到已经不该出现的旧候选。

**根因**：fish 式"防闪烁"快路径在"新输入仍是旧建议前缀"时直接保留候选、不重算。若只检查**当前展示那条**仍前缀匹配，或列表已经被截断（本来可能还有更合适的候选没进来），就会保留过期 / 不完整的结果。

**正确姿势**：快路径只在**每一个旧候选都仍前缀匹配**且**候选列表未达上限（没被截断）**时才生效，否则走全量 `findCandidates`。

涉及：`src/suggestion-store.ts`。

---

## 7. `toLowerCase()` 会改变字符串长度——别用"等长"假设做前缀比较

**症状**：个别 Unicode 输入下高亮 / 后缀切片错位。

**根因**：大小写折叠不保证长度不变，例如 `"İ".toLowerCase()` → `"i̇"`（1 个码元变 2 个）。假设 `lower.length === original.length` 的代码会错位。

**正确姿势**：比较时取候选整串**与输入等长的头**（按对齐后的边界而非小写串长度假设），或用既保留原文边界又大小写无关的比较方式。

涉及：`src/ghost-overlay.tsx`（`computeInlineSuffixFromPrefix`）。

---

## 8. 诊断探针路径不要硬编码用户目录；且探针是开发期脚手架，发布前必须整段移除

**症状**：探针把文件写死到某个固定的用户目录（例如 `<用户主目录>/...`），换机器 / 换安装位置就失效，还可能泄露本机路径。

**正确姿势**：探针路径由**模块自身位置**推导（`dirname(fileURLToPath(import.meta.url))` 上一级当仓库根），安装到哪里就写到哪里，绝不硬编码用户名或绝对路径。注意：探针会在每次运行 / 出错时**无条件写文件**，属于开发期脚手架——**发布前必须移除全部探针接线与文件**。

涉及：`src/probe-log.ts`、`src/context-probe.ts`。

---

## 9. Bun 的 `mock.module` 会跨测试文件污染——必须逐文件跑

**症状**：单独跑每个测试文件全 PASS，合并成 `bun test test/` 却出现莫名失败。

**根因**：Bun 的 `mock.module` 状态在同一进程内的多个测试文件之间**共享 / 污染**。

**正确姿势**：核心测试**逐文件独立进程**运行（一个文件一次 `bun test <file>`），不要合并成一条命令；断言也基于逐文件结果。

---

## 10. `$LASTEXITCODE` 经 Windows 的 bun shim 不可靠——看输出文本判 PASS/FAIL

**症状**：脚本里 `if ($LASTEXITCODE -ne 0)` 在 bun 明明通过时也报错。

**正确姿势**：以测试输出文本为准（如"测试结论：全部 PASS" / `N pass N fail`），或直接在 `bash` 下跑 bun 原生命令；不要依赖 Windows shim 的退出码。

---

## 11. 多行 commit message 经 shell 会损坏——写文件后 `git commit -F`

**症状**：`git commit -m "首行\n\n正文"` 在 PowerShell / 某些 shell 下被截断或转义错乱。

**正确姿势**：把 message 写进临时文件，再 `git commit -F <file>`。

---

## 12. `/reload` 不重载插件本体——测新版本必须完整重启 TUI

**症状**：改了代码、`/reload` 后行为没变，甚至像在跑旧版本。

**根因**：`/reload` 只拆除旧实例的接线（slot / 订阅 / 定时器），**不重载插件模块本体**，还可能留下重复死实例。

**正确姿势**：测任何新版本一律**完整重启 TUI**。

（相关：宿主在开发态会因源文件摘要变化而换代重载插件——`activate()` 会先 `deactivate` 上一代再 `setup`，因此探针日志里同名进程出现多次 `setup` 属于热重载换代 churn，不是重复注册。）

---

## 13. 插件的 `console.*` 进不了宿主 `opencode.log`——要落日志得自己写文件

**说明**：据 `opencode-usage-meter` 对 26MB 宿主日志的全量取证（横跨多个版本），插件侧 `console.log/error` 输出**0 行**落入 `~/.local/share/opencode/log/opencode.log`；宿主日志只记它自己的结构化事件。需要诊断输出时，要么让探针自己写文件（见第 8 条，发布前删），要么另找可观测通道。

---

## 14. `edit` 报 `Could not find oldString` 时的处理

**根因**：几乎从不是环境问题（LF、无 BOM、`core.autocrlf=false`），而是 `oldString` 与磁盘不一致（缩进列数、不可见尾随空格、空行被合并）。

**正确姿势**：先 `read` 再 `edit`，`oldString` 逐字节复制；用 3–8 行最小锚点；同一文件一轮只发一次 `edit`（多处改动分轮串行，或整文件 `write`）；失败后先 `read` 再重试，别盲猜第三次。
