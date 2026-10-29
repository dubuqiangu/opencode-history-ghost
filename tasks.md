# opencode-history-ghost 任务列表

依赖顺序执行；每个任务标注写权限 lane（A=纯逻辑 / B=TUI 集成 / O=orchestrator）。

## T1 骨架与契约【B】
- [x] package.json（skill 契约 + fuzzysort 依赖）、src/index.ts 占位、.gitignore、LICENSE(MIT)

## T2 数据源 history-source.ts【A】
- [x] DB 路径解析 / 三级降级 / schema 自适应 / jsonl 过滤去重 / refresh mtime 检测

## T3 匹配引擎 matcher.ts【A】
- [x] 防御过滤 + 三桶分层 + 档内最新优先 + 去重截断（fuzzysort 4.0.2 实证 API）

## T4 逻辑冒烟 scripts/dev-smoke.ts【A】
- [x] 真库 1514 条；单次匹配 0.004–0.56ms；bun/tsx 双运行时 PASS

## T5 editor-bridge.ts【B】
- [x] 防御访问 / onContentChange 幂等包装 / 1.5s 身份轮询 / dispose 清理

## T6 suggestion-store.ts【B】
- [x] 状态 + evaluate（增量快路径）+ cycle + dismiss + clear
- [x] 【修复轮】solid-js 影子副本 → 命令式状态 + onStateChange（oracle 必修项 1）

## T7 ghost-line.tsx【B】
- [x] composer.top slot + 双色行 + (N/M) + 多行注记 + 100 截断
- [x] 【修复轮】命令式 createGhostLine 控制器替换 createMemo 组件（oracle 必修项 1）

## T8 keymap.ts【B】
- [x] layer 五命令 + 补全弹窗 mode 隔离
- [x] 【修复轮】注册挪入独立 app slot（oracle 必修项 2：会话作用域失活）；accept 加 cursorAtEnd 守卫
- [x] 【修复轮】editor-bridge 双 wrapper 完整性自愈轮询（oracle 项 3）；onCursorChange 挂钩（oracle 项 6）

## T9 tui.tsx 装配 + README【B】
- [x] setup 组装 + 3s refresh + cleanup 全清；README 三种安装方式/配置/排障/限制
- [x] 【修复轮】storage 缺失兜底（oracle 项 17）；README 安装键名 plugins 修正（oracle 项 7）

## T10 全量合成验证【O】
- [x] 合成 esbuild 零报错；冒烟全 PASS；src 无 solid-js 导入

## T2b/T4b 跟进轮【A】（oracle 项 8/14）
- [x] DB 查询加 LIMIT maxEntries（163ms → 144ms，端到端由最新行物化主导，提升如实记录）
- [x] dev-smoke 真实历史明文前 3 字符 → '***' 掩码（含夹具 NTFS mtime 刷新延迟修复）
- 验证：esbuild + bun/tsx 双运行时冒烟 PASS

## T6b/T8b 跟进轮【B】（oracle 项 4/5）
- [x] trim 归一：evaluate 入口 trim，state.input/快路径/dismiss/高亮统一用 trimmed
- [x] 历史方案：曾以旧实例存活与否区分 composer/对话框，后续确认身份依据不足，已移除；现使用私有 Prompt 树 footer marker 结构适配器，未知身份 fail-closed（见身份修复轮）。
- 历史自动验证：esbuild 逐文件 + bundle PASS；T11 ⑪/⑫ **未**完成真机验收。

## T11 本机安装 + 手测【O+用户】
- [x] opencode.json 已加 file:// 本地挂载条目（指向本插件目录；备份 opencode.json.bak.20261015_083848）
- [x] 诊断（2026-10-15）：`opencode plugin list` 不显示本插件 → 查明服务端进程 2026-10-14 16:48 启动，
      早于 08:38 的配置修改，运行中服务持有旧配置快照（file:// 条目格式经官方 skill 契约+宿主源码双重核实无误）。
      唯一解释：需重启服务后才会加载；非配置 bug。
- [ ] 重启 TUI（需用户操作），手测 12 项：
      ① 前缀出灰字行 ② Tab 整句替换 ③ 输入跟随更新 ④ ctrl+↑↓ 循环 (N/M)
      ⑤ Esc 消失再输入恢复 ⑥ / 或 @ 不触发 ⑦ 补全弹窗时 Tab 归宿主
       ⑧ palette 开关持久 ⑨ 空输入/短输入无建议 ⑩ ← 移光标按光标前缀重新评估建议；偏移无法可靠映射时建议消失
       ⑪ 对话框/权限输入不弹建议、Tab/Esc 不被劫持；核对真实宿主 Prompt 父子链与 marker 所在 footer
      ⑫ 切会话/回 home 再进，Tab/Esc 仍有效（验证 app slot 修复）
      另观察：无建议时是否残留空行

## T13 oracle 增量复审 + 终版小修【O】
- [x] 历史代码级审查：当时 10 项原缺陷验收；不代表身份修复后的宿主 TUI 真机验证。
- [x] N1 候选存储/去重统一 trim（防"接受后同条建议立即重弹"）——history-source.ts appendFilteredEntry
- [x] N2 历史记录：曾修订旧版启发式的首挂载误认说明；该启发式现已移除，见身份修复轮。
- [x] N3 package.json 删除 solid-js peerDependency（src 已零导入，防影子拷贝误导）
- [x] N4 README 冒烟掩码措辞同步（*** 全掩码）
- [x] .gitignore 已含 node_modules/
- [x] 复验：合成 esbuild 零报错 + 冒烟全 PASS
- 历史判定：N5 卸载瞬间宿主槽恢复语义未处理；N6 旧版"活着换实例"风险现由身份结构校验替代，仍需真机确认。

## T14 oracle 终态验收审计【O】
- [x] 历史验收：N1/N2/N4 当时通过（N1 不变式严格成立，顺带修复跨源去重）；旧 N2 描述已由身份修复轮取代。
- [x] N3 验收：package.json/src 已干净，但 package-lock.json 失同步（残留 solid-js peerDep，npm ci 必挂）→ 交 fixer
- [x] 配置双键判定："plugin"（单数，npm 托管）与 "plugins"（复数，V2 统一入口）均为宿主官方键，各司其职，无需清理
- [x] 终版低危修复 6 项（fix-3 完成）：① lockfile 重生成（根条目无 solid-js）② wrapper 自引用守卫（Symbol.for 标记+解包，反事实探针验证）③ 内部 CRLF 归一（normalizeLineEndings，trim 前归一）④ 冒烟夹具 try/catch+finally 双层清理 ⑤ README ctrl+↑↓ 终端兼容第 6 条 ⑥ 降级 warn 带底层原因（SqliteOpenOutcome）
- [x] 验证：esbuild 零报错 + bun/tsx 双运行时冒烟全 PASS（夹具目录清盘）+ lockfile 核对通过

## T15 一键安装验证脚本 + README 格式对齐【F，已完成】
- [x] scripts/verify-install.ps1：双模式——file://（默认，要求 plugins 的 file URI 实际指向当前仓库；exports/esbuild/冒烟/lockfile/根文件）与 -Mode github（会执行 plugin update；HEAD/list/stamp/逐项 tracked 文件 SHA256/插件数组精确注册）；两模式运行 Bun 核心回归并查 PASS 与退出码。file 模式不依赖 git。
- [x] README.md 仿 usage-meter 重排：简介+ASCII 预览+亮点→快速开始（三方式+重启必载+一键自检）→功能一览 7 行表→配置/排障/已知限制 6 条/隐私/开发/License
- [x] 历史记录：原 file 模式曾全 PASS exit 0；当时只以包含插件名的 file 字符串判注册，未确认指向仓库，也未运行核心回归。当前 GitHub 安装下重新运行严格 file 模式应注册 FAIL，不能把旧 PASS 当作当前真机验证。
- 参考：opencode-usage-meter 的 scripts/verify-install.ps1 + README.md 结构（同工作区姊妹插件）

## T16 第四轮审查收敛【F，已完成】
- [x] verify-install.ps1 V1-V5 修补（V1 缺命令时崩溃改 FAIL 行——人为剥 PATH 复现：npx/bun 各输出 FAIL 行带异常信息，VERIFY FAILED exit 1；V2 npx --yes；V3 git 空头短路不空转 120s；V4 配置 parse 错误入 Detail；V5 临时转换产物 finally 清盘；当时命令不带 `--bundle`，不能视作完整依赖图测试）
- [x] P0 单元测试 test/ghost-core.test.ts（5 用例：store dismiss/re-arm、快路径 candidates 引用严格不变、N1 不变式、bridge 槽位覆写自愈、Symbol 守卫防嵌套放大；dev-smoke 风格双运行时 bun/tsx 22 断言全 PASS；测试专用暴露点 runIntegrityPollOnce，产品行为零改动）
- [x] DESIGN.md 同步 D1-D17（Solid 描述→命令式状态+onStateChange+静态 JSX+ref+patch+requestRender、LIMIT 参数绑定、归一+trim+Set 跨源去重、9 方法契约、双槽包装+1.5s 自愈+Symbol.for 守卫、registerKeymap 返回 cleanup、run 级一致性校验+cursorAtEnd、独立 app slot、边界表 5 行补齐、已知限制 6 条、*** 全掩码、evaluate 第 0 层 trim-once、cleanup 清单 8 项；逐条以 src 实读核对）
- [x] README 性能数字与本次冒烟实测对齐（2026-10-16 实测：812 条历史，单次匹配 0.004–0.117ms，以 scripts/dev-smoke.ts 输出为准）
- 历史验证：旧版 verify-install 修补后曾全 PASS exit 0 + V1 人为复现 FAIL 路径 exit 1 + 双运行时 5 用例 PASS + esbuild 复跑零报错；不表示当前宿主安装或真实 DB 已验收。
- P1/P2（发布后）：matcher 对抗五件套、history-source 归一化专项、keymap run 守卫 mock、ghost-line computeSegments 导出

## T17 上库与一键安装【O，2026-10-16 完成】
- [x] README 占位符填实（dubuqiangu）；本机绝对路径 3 处脱敏（README 安装示例 + tasks.md 2 处）
- [x] 脱敏扫描（独立步骤、读完输出才 push）：凭据零命中、运行期产物零命中、绝对路径脱敏后复扫干净
- [x] git init + commit + 推送 + tag v0.1.0：https://github.com/dubuqiangu/opencode-history-ghost（master）
- [x] 本地安装切换：file:// 条目移除（备份 opencode.json.bak.20261016_085430）→ `opencode plugin add github:dubuqiangu/opencode-history-ghost` 成功
- [x] 发布链修复两处：① verify-install github 模式动态解析分支（原硬编码 origin/main）② index.ts 空占位导致服务端记录插件损坏（plugin list 显示 "- -"）→ 改为 default 导出 {id, setup}（姊妹插件实证模式）
- [x] 历史记录：旧版 verify-install -Mode github 曾显示 7 项全 PASS（HEAD=635897e、stamp v0.1.0）；当时配置以全文 Contains 判定、src/scripts 只比较数量，均可能误报；不作为当前版本真机验收。
- 历史记录（v0.1.0 安装时）：2026-10-14 启动的服务端持有旧配置快照，`plugin update` 曾输出 "Failed to check Server plugin"；这不代表 v0.1.1 的运行状态，是否消失及插件是否加载均待父代理真机确认。

## T18 editor-bridge 真实 SDK 契约修复【F，待真机验收】
- [x] `currentFocusedEditor` 改直接读取 getter 并绑定 SDK 类型；双槽未安装/undefined 与已安装区分；空焦点轮询避开 null 完整性校验。
- [x] Bun 真实 renderer/textarea + 固定历史源 Solid slot 总链路回归；双槽初始 undefined、宿主已有 listener、空焦点轮询、假 renderer 同实例覆写及迁移守卫。
- [x] 自动 RED→GREEN：新增真实 SDK getter/textarea/slot 回归先在旧桥接实现上复现 17 处失败（含 getter 调用异常与 ghost 未显示），再修复至 Bun 全 PASS；Node 逻辑模拟全 PASS，真实 renderer 因 Node 缺 OpenTUI native FFI 明确跳过。仅为自动验证，非宿主真机验收。
- [x] 补丁版发布前准备：package.json 与 package-lock.json 根版本同步至 0.1.1；根 peerDependencies 不含 solid-js。未提交/推送/更新宿主安装。
- [ ] 父代理负责最终真机验证及发布；合成构建/自动回归不代表真机加载成功。

## T19 安装验证判据收紧【F，待父代理真机验收】
- [x] file 注册项核对 file URI 规范化后的实际仓库路径；github 注册项仅认可 plugins 数组精确 ID；两模式运行 Bun 核心回归并要求 PASS/零 FAIL/exit 0；github 已安装 src/scripts 对应 git tracked 路径逐文件 SHA256 比对，update 失败单独 FAIL。
- [x] `pwsh test/verify-install.test.ps1` 静态语法与临时 fixture 负例全部 PASS（含同文件数但不同内容、插件名相同而错误路径、github ID 只在无关字段）。
- [x] `bun test/ghost-core.test.ts` 与 `bun test/editor-bridge-regression.test.ts` 全部 PASS；当前 GitHub 安装下 `pwsh scripts/verify-install.ps1 -Mode file` 符合预期仅注册项 FAIL、exit 1，其余检查 PASS；未更改用户配置/安装，也未运行会调用 plugin update 的 github 模式。
- [ ] 等获许可后由父代理运行 github 模式并重启 TUI 人工验收；当前自动 PASS 不证明真实 DB 已打开或真实宿主端到端延迟 <1ms（T20 仅测合成匹配）。

## T20 冒烟性能门槛及独立回归【F，自动验证；真机待验】
- [x] 历史阶段：双模式验证起初分别启动四个独立 Bun 进程：ghost-core、editor-bridge-regression、history-completeness、ghost-remount；之后补入 composer-identity 与 history-scan-performance，当时共六项，仍不共享 mock.module 测试进程（本轮已扩为八项，见文末）。
- [x] 两模式均运行 dev-smoke；输出本机合并条目数与 DB 成功加载次数；无 DB 明示「未验证」，默认可降级，`--require-real-db` 明确要求真实 DB 并在未加载时退出 1。合并条目数不是 DB 独立条目数。
- [x] 合成固定 2000 条非个人历史涵盖前缀/子串/fuzzy；每桶预热 100 次，两轮各 101 次取较快轮 p95，`findCandidates` 单次稳态 p95 <1ms 为自动门槛，超限脚本 FAIL/退出 1；**不涵盖** DB 加载、TUI 渲染、I/O 或单次最坏延迟。
- [ ] T11 仍需用户重启宿主进行真机验收；现按私有 Prompt 树结构证明 composer 身份，未知结构 fail-closed，真实宿主父子链未确认。数据优先级 jsonl > V2 > legacy、各源内部最新在前且跨源不比较时间戳，不代表现网每种来源均已证实。

## 身份修复轮及安装验证补齐【自动回归；真机未验】
- [x] 移除旧编辑器死亡自动采纳启发式；基于 OpenCode v2.0.29 私有 Prompt 树 `prompt.footer` marker、当前 session 路由、textarea 父子链与唯一性证明身份；未知树/路由/焦点 fail-closed。当前代码**不检测宿主版本号**。
- [x] `test/composer-identity.test.ts` 使用真实 renderer 搭建模拟 Prompt 树，覆盖首挂对话框、重建、切路由、重复 marker、权限/表单输入；两验证模式保留该独立 Bun 进程、原四项回归及冒烟，并新增历史扫描性能回归。
- [ ] T11/T12：宿主 TUI 的实际 Prompt 父子链及按键不劫持、重启后跨会话行为均待人工验收；历史上发布 v0.1.1 不表示当前工作树修复已发布或已在宿主安装。

## 最新复核与构建判据校准【自动检查；真机未验】
- [x] oracle 复核未发现新增 P0/P1；可安排**受控**宿主真机验收，但 T11/T12 仍未完成。OpenCode v2.0.29 仅是私有 Prompt 树结构参考，并非代码已实施的版本门槛；真实宿主 footer 父子链及宿主/插件 OpenTUI 构造器共享仍需实测。
- [x] verify-install 的原 esbuild 调用无 `--bundle`：将 PASS 标签改为“入口 TSX 语法转换成功”，另加 SDK/Node external 的真实本地依赖图 `--bundle` 检查；PS 静态判据/负例与两项构建命令均已独立 PASS，临时产物已清理。external 是否可在宿主运行不在该检查范围。
- [x] P2 自动缓解：另 lane 已将同步 OFFSET 翻页换为绑定 keyset（V2 `(time_created,rowid)`、legacy 三元 tuple、NULL 时间末尾单独扫描，其中 NULL 续页用 `(message.rowid,part.rowid) < (?,?)`），每页 `setImmediate` 让出；`test/history-scan-performance.test.ts` 分别覆盖 112k 行合成大库与 60k 消息/120001 parts NULL 时间夹具，本机后者旧 8.7s→新 136ms（仅观测，非保证）。双模式独立 Bun 回归连同原五项共六项；六回归、双运行时 smoke、PS 负例已重新通过。
- [x] oracle SQL 代码级复核：静态库未发现遗漏/重复、NULL 阶段或 Node 接口问题；不等于并发 WAL 同一快照保证（新插入更晚行可能不收、旧行可能收）。
- [ ] P2 真正端到端收敛仍需真实 DB 和 T11/T12 宿主真机验证；非 NULL 单消息海量 parts、无索引单页仍可能阻塞，实际宿主流畅度未获保证，不能以合成夹具 PASS 代替。

## T12 收敛检查【O】
- [x] 结构追溯：文件结构与 DESIGN §3 完全一致
- [x] 代码级追溯：oracle 增量复审逐项验收通过（见 T13）
- [ ] 用户验收（= T11 手测结果）

## 发布门【O+用户】
- [ ] 征询推送 GitHub；确认后先跑敏感信息扫描（真实凭据形状 + 本机路径/用户名 + 运行期产物）再 push

## 光标前缀语义增补【B，自动验证；T11/T12 仍待真人】
- [x] 新增真实 SDK 回归先复现红灯，再实现 display-cell `getTextRange` 光标前缀；CJK/emoji/组合音符/多行及行尾、宿主 modal/autocomplete、外来焦点、静默全文/光标变更覆盖。
- [x] 光标移动立即重评估，接受前比较候选快照全文、光标前缀和偏移；Tab 继续 `replaceText` 整段。无法证明 offset 映射时 fail-closed。
- [ ] T11/T12 真实宿主加载、Prompt 树身份与真实 TUI 键盘行为仍需人工验收；不以自动回归替代。

## 本次 file 模式双配置判据修复【自动验证；T11/T12 未完成】
- [x] 查明 OpenCode v2 TUI 外部插件取自 `~/.config/opencode/cli.json` 的 `plugins` 数组；服务端 `opencode.json` 的 file URI 单独存在不能证明 TUI 已装。此前仅服务端配置的诊断及 file 模式 PASS 不足以证明 TUI 已加载。本地开发需先备份并临时在两份配置登记同一指向现存仓库的 file URI，正式 GitHub 注册方式不变。
- [x] file 验证改为检查两份配置的插件数组及实际目录；临时测试夹具覆盖仅服务端注册、TUI 配置缺失/解析错/指错目录等负例，不接触真实配置。
- [ ] T11/T12 的重启、实际加载、光标前缀与按键行为仍待用户人工验收；自动 PASS 不是宿主真机验证。
- 历史失败记录（**已解决，非当前状态**）：当时 `pwsh test/verify-install.test.ps1` 负例全部 PASS；`pwsh scripts/verify-install.ps1 -Mode file` 双配置注册及其余检查 PASS，但独立 `bun test/editor-bridge-regression.test.ts` 为 PASS=37/FAIL=1、exit=1，导致当时整体验证 exit=1。后续修复后整体验证与该回归均已通过，见下节；当时未执行 github 模式、plugin update、宿主重启、提交或推送。

## 本轮文档同步与安装验证【自动验证；T11/T12 待验】
- [x] `src/keymap.ts` 将建议快捷键放在需候选、总开关开启、可信 composer 聚焦且非 autocomplete/modal 的层；无绑定按键的 palette toggle 单独注册在全局层，不依赖建议或 composer 焦点，总开关关闭时仍可触达。
- [x] 安装脚本各自独立进程运行八项 Bun 回归：ghost-core、editor-bridge-regression、tui-load-diagnostic、caret-prefix-accept、history-completeness、ghost-remount、composer-identity、history-scan-performance；新增两项已纳入脚本。
- [x] 双配置 file 安装验证 `pwsh scripts/verify-install.ps1 -Mode file` 整体 PASS（八项 Bun 回归均作为脚本子项 PASS）；`pwsh test/verify-install.test.ps1` PS contract PASS。旧版 editor-bridge-regression FAIL 已修复，不能将旧记录视为当前失败；此处不声明 Node tsx 回归通过。
- [ ] T11/T12 真实宿主 TUI 加载、Prompt 身份与光标/按键行为仍待人工验收；本轮未重启宿主、未执行 plugin update、未提交或推送。

## 根目录 file URI 入口解析闭环【自动检查；T11/T12 仍待真人】
- [x] 区分配置已登记与入口可解析：双份配置均指向仓库根目录，`package.json` exports 指向 `src/index.ts` 与 `src/tui.tsx` 不保证无包名目录的 `Host.resolve({directory: repoRoot})` 找到根级 server/tui；本地 SDK 2.0.29 探测根级 `index`/`tui`，需根入口桥接。研究宿主源码 2.0.26；未证明 v2.0.32 宿主真机成功。正式 GitHub 安装和根目录 file URI 保持不变。
- [x] file 模式追加调用本地 SDK 的 Host.resolve，仅检查 server/tui 是否可解析，不调用 Host.load；PS 临时夹具用有效 src exports、双配置 URI、空根入口证明负例 FAIL（无宿主配置写入）。两模式新增第九项独立 Bun `bun test test/entry-resolution.test.ts` 回归；原八项脚本子项 PASS 是改动前的历史记录。本轮 `pwsh test/verify-install.test.ps1` 负例及 `pwsh scripts/verify-install.ps1 -Mode file`（九回归各自子项）均 PASS、后者 exit 0。
- [ ] T11/T12：重启及真实 TUI 入口加载、身份/光标/键盘与 DB 行为仍需用户人工验收；自动解析通过不能替代。未执行安装、更新、提交或推送。
- [ ] 新增真机观察：补齐根入口后 TUI 进入加载，但报 OpenTUI duplicate env var `OPENTUI_FORCE_UNICODE`（现有 mode2026 / 新 mode2027）。入口可解析≠依赖能在宿主中导入，更不等于插件可用；本地 SDK `Host.load` 回归也无法替代真实宿主。父代理继续排查，T11/T12 保持未完成。

## 单文件 TUI 交付与安装判据【静态回归；T11/T12 仍未完成】
- [x] OpenTUI 模式冲突采用项目选定 `npm run build:tui` 单文件业务 bundle，发布必须携带 `dist/tui.js`；`@opentui/*`、`solid-js` 与宿主 SDK external，不带插件侧影子实例。`package.json` 的 `./tui` export 与根级 `tui.js` 桥接均指向同一 `./dist/tui.js`；动态 `bun:sqlite` 是合法 Bun 运行时导入。此前 OpenTUI 冲突观察是旧入口状态，不表示新交付已在真机通过。
- [x] file/github 两模式共享第十项独立 `bun test test/tui-delivery.test.ts`：静态检查实际交付文件而不是只做 graph-check；PS 安装脚本合同覆盖调用清单、`-UseTestRunner` 与缺失/误调用负例。github 模式额外对安装 stamp 中 bundle 和根桥接与本地交付文件逐一 SHA256 比对，缺失或不同均 FAIL。
- [ ] 发布前重新构建并确认 `dist/tui.js` 随发布进入仓库/安装包；自动 PASS 不是宿主真机证明。T11/T12 的真实加载、同一 OpenTUI/Solid 实例、历史读取及交互仍待人工验收；本轮不修改宿主配置、不安装或更新插件、不重启宿主、不提交或推送。

## 历史变化后静止输入重评估【待修复；T11/T12 未通过】
- [ ] 已确认缺陷：DB `whenReady()` 完成、jsonl mtime 变化时，即便历史候选池改变，静止输入也不会自动触发建议重评估；预期仅在可信 composer 上重新读取光标前缀并评估，未知/外来编辑器继续 fail-closed，`Esc` 对同一输入的压制不能因刷新而失效。
- [x] file/github 两模式共享第十一项独立 `bun test test/history-reassessment.test.ts` 调用；PS 合同将其列为必需，删除或移除 `-UseTestRunner` 时判据必须变红。这只登记验证入口，不声明新回归或产品修复已通过。
- [ ] 单文件 bundle 的任意 `src/` 改动后都需重新构建 `dist/tui.js`，重跑交付测试，之后才可判断交付状态；真实 TUI 灰字缺席仍未定因，T11/T12 未通过。此轮不改历史内容、宿主配置，不安装/更新、重启、提交或推送。
