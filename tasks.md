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
- [x] 对话框劫持守卫：mode 排除/既有手法均无据否决 → 存活-迁移守卫（外来实例拒包装+清建议）+ run 级一致性校验 + README 残留风险第 5 条
- 验证：esbuild 逐文件 + bundle PASS；T11 ⑪/⑫ 实测确认

## T11 本机安装 + 手测【O+用户】
- [x] opencode.json 已加 file:// 本地挂载条目（指向本插件目录；备份 opencode.json.bak.20261015_083848）
- [x] 诊断（2026-10-15）：`opencode plugin list` 不显示本插件 → 查明服务端进程 2026-10-14 16:48 启动，
      早于 08:38 的配置修改，运行中服务持有旧配置快照（file:// 条目格式经官方 skill 契约+宿主源码双重核实无误）。
      唯一解释：需重启服务后才会加载；非配置 bug。
- [ ] 重启 TUI（需用户操作），手测 12 项：
      ① 前缀出灰字行 ② Tab 整句替换 ③ 输入跟随更新 ④ ctrl+↑↓ 循环 (N/M)
      ⑤ Esc 消失再输入恢复 ⑥ / 或 @ 不触发 ⑦ 补全弹窗时 Tab 归宿主
      ⑧ palette 开关持久 ⑨ 空输入/短输入无建议 ⑩ ← 移光标建议消失
      ⑪ 对话框输入不弹建议、Tab 不改写对话框（验证守卫）
      ⑫ 切会话/回 home 再进，Tab/Esc 仍有效（验证 app slot 修复）
      另观察：无建议时是否残留空行

## T13 oracle 增量复审 + 终版小修【O】
- [x] 10 项原缺陷逐项验收：全部已修复（含冷启动路径、renderRow 同实例、keymap 一致性守卫误杀三个专项核查）
- [x] N1 候选存储/去重统一 trim（防"接受后同条建议立即重弹"）——history-source.ts appendFilteredEntry
- [x] N2 README 已知限制第 5 条首挂载窗口措辞修正（实际行为是对话框被临时误认，关闭后自愈）
- [x] N3 package.json 删除 solid-js peerDependency（src 已零导入，防影子拷贝误导）
- [x] N4 README 冒烟掩码措辞同步（*** 全掩码）
- [x] .gitignore 已含 node_modules/
- [x] 复验：合成 esbuild 零报错 + 冒烟全 PASS
- 记录不修（oracle 判定）：N5 卸载瞬间宿主槽恢复语义、N6 未来宿主"活着换实例"场景（README 已声明）

## T14 oracle 终态验收审计【O】
- [x] N1/N2/N4 验收通过（N1 不变式严格成立，顺带修复跨源去重；N2/N4 措辞与行为一致）
- [x] N3 验收：package.json/src 已干净，但 package-lock.json 失同步（残留 solid-js peerDep，npm ci 必挂）→ 交 fixer
- [x] 配置双键判定："plugin"（单数，npm 托管）与 "plugins"（复数，V2 统一入口）均为宿主官方键，各司其职，无需清理
- [x] 终版低危修复 6 项（fix-3 完成）：① lockfile 重生成（根条目无 solid-js）② wrapper 自引用守卫（Symbol.for 标记+解包，反事实探针验证）③ 内部 CRLF 归一（normalizeLineEndings，trim 前归一）④ 冒烟夹具 try/catch+finally 双层清理 ⑤ README ctrl+↑↓ 终端兼容第 6 条 ⑥ 降级 warn 带底层原因（SqliteOpenOutcome）
- [x] 验证：esbuild 零报错 + bun/tsx 双运行时冒烟全 PASS（夹具目录清盘）+ lockfile 核对通过

## T15 一键安装验证脚本 + README 格式对齐【F，已完成】
- [x] scripts/verify-install.ps1：双模式——file://（默认，6 项检查：注册条目/exports 目标/esbuild/冒烟双条件/lockfile 防回归/根文件）与 -Mode github（发布链：HEAD 推送→update→list commit→stamp 版本→src+scripts 树镜像→注册）；file 模式不依赖 git
- [x] README.md 仿 usage-meter 重排：简介+ASCII 预览+亮点→快速开始（三方式+重启必载+一键自检）→功能一览 7 行表→配置/排障/已知限制 6 条/隐私/开发/License
- [x] 验证：verify-install.ps1 file 模式实跑全 PASS exit 0（含判据假 PASS 自查修正）；README 逐项比对无信息丢失、无死链；src/ 零改动
- 参考：opencode-usage-meter 的 scripts/verify-install.ps1 + README.md 结构（同工作区姊妹插件）

## T16 第四轮审查收敛【F，已完成】
- [x] verify-install.ps1 V1-V5 修补（V1 缺命令时崩溃改 FAIL 行——人为剥 PATH 复现：npx/bun 各输出 FAIL 行带异常信息，VERIFY FAILED exit 1；V2 npx --yes；V3 git 空头短路不空转 120s；V4 配置 parse 错误入 Detail；V5 临时 bundle finally 清盘）
- [x] P0 单元测试 test/ghost-core.test.ts（5 用例：store dismiss/re-arm、快路径 candidates 引用严格不变、N1 不变式、bridge 槽位覆写自愈、Symbol 守卫防嵌套放大；dev-smoke 风格双运行时 bun/tsx 22 断言全 PASS；测试专用暴露点 runIntegrityPollOnce，产品行为零改动）
- [x] DESIGN.md 同步 D1-D17（Solid 描述→命令式状态+onStateChange+静态 JSX+ref+patch+requestRender、LIMIT 参数绑定、归一+trim+Set 跨源去重、9 方法契约、双槽包装+1.5s 自愈+Symbol.for 守卫、registerKeymap 返回 cleanup、run 级一致性校验+cursorAtEnd、独立 app slot、边界表 5 行补齐、已知限制 6 条、*** 全掩码、evaluate 第 0 层 trim-once、cleanup 清单 8 项；逐条以 src 实读核对）
- [x] README 性能数字与本次冒烟实测对齐（2026-10-16 实测：812 条历史，单次匹配 0.004–0.117ms，以 scripts/dev-smoke.ts 输出为准）
- 验证：verify-install 修补后全 PASS exit 0 + V1 人为复现 FAIL 路径 exit 1 + 双运行时 5 用例 PASS + esbuild 复跑零报错 + DESIGN 抽查对照行号
- P1/P2（发布后）：matcher 对抗五件套、history-source 归一化专项、keymap run 守卫 mock、ghost-line computeSegments 导出

## T12 收敛检查【O】
- [x] 结构追溯：文件结构与 DESIGN §3 完全一致
- [x] 代码级追溯：oracle 增量复审逐项验收通过（见 T13）
- [ ] 用户验收（= T11 手测结果）

## 发布门【O+用户】
- [ ] 征询推送 GitHub；确认后先跑敏感信息扫描（真实凭据形状 + 本机路径/用户名 + 运行期产物）再 push

