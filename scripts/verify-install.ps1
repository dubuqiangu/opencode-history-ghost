# verify-install.ps1 — opencode-history-ghost 一键安装自验证。
# Run from anywhere:  pwsh <plugin>/scripts/verify-install.ps1
#
# 双模式验证链:
#   file (默认, file:// 本地安装): server opencode.json 与 v2 TUI cli.json 的 plugins
#        均以 file:// 注册指向本仓库 -> package.json
#        exports 目标存在 -> 本地 SDK Host.resolve 根入口可解析（不证明真实宿主模块依赖可导入）
#        -> esbuild 入口转换和本地依赖图构建零报错 -> 冒烟与十一项独立 Bun 回归全 PASS
#        （交付回归检查真实 dist/tui.js 与根级桥接，而非仅 graph-check） ->
#        lockfile 根条目 peerDependencies 无 solid-js 回归 -> 根文件齐全。
#   github (发布后): HEAD 已推送 -> opencode plugin update -> plugin list
#        commit 一致 -> 落盘 stamp 版本与 package.json 一致 -> src/scripts
#        tracked 文件逐一哈希比对 -> tui exports 目标与桥接在 stamp 中和本地逐文件哈希一致
#        -> opencode.json 注册 -> 冒烟与十一项独立 Bun 回归全 PASS。
# github 模式会执行 plugin update（修改宿主安装）；仅在明确允许更新时运行。
# 每项检查输出一行 PASS/FAIL; 仅当全部通过时 exit 0。
#
# 注意: file 模式完全不调用 git（无 git 的本地目录也可校验）；github 模式
# 需要 git (HEAD/origin 比对与 tracked 文件哈希),
# git rev-parse 失败时静默取空值, 该项检查以 FAIL 呈现而非脚本崩溃。
param(
  [string]$Mode = "file",
  [string]$PluginId = "github:dubuqiangu/opencode-history-ghost",
  [int]$InstallTimeoutSeconds = 120
)

$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$repoRoot = Split-Path $PSScriptRoot -Parent
$script:failures = 0

function Assert-Check {
  param([string]$Label, [bool]$Condition, [string]$Detail = "")
  $suffix = if ($Detail) { "  ($Detail)" } else { "" }
  if ($Condition) {
    Write-Output ("PASS  " + $Label + $suffix)
  } else {
    Write-Output ("FAIL  " + $Label + $suffix)
    $script:failures++
  }
}

function Read-PluginEntries {
  param([string]$ConfigPath)
  $configuration = Get-Content $ConfigPath -Raw -Encoding UTF8 | ConvertFrom-Json
  if ($configuration.plugins -isnot [array]) { throw "$(Split-Path $ConfigPath -Leaf) plugins must be an array" }
  return $configuration.plugins
}

function Test-FilePluginEntry {
  param([object[]]$Entries, [string]$RepositoryRoot)
  $expectedPath = (Resolve-Path -LiteralPath $RepositoryRoot -ErrorAction Stop).ProviderPath.TrimEnd('\', '/')
  foreach ($entry in $Entries) {
    if ($entry -isnot [string]) { continue }
    $uri = $null
    if (-not [uri]::TryCreate($entry, [System.UriKind]::Absolute, [ref]$uri)) { continue }
    if (-not $uri.IsFile -or $uri.Query -or $uri.Fragment -or -not $uri.IsLoopback) { continue }
    $pluginPath = $uri.LocalPath
    if (-not (Test-Path -LiteralPath $pluginPath -PathType Container)) { continue }
    $actualPath = (Resolve-Path -LiteralPath $pluginPath).ProviderPath.TrimEnd('\', '/')
    if ([string]::Equals($actualPath, $expectedPath, [System.StringComparison]::OrdinalIgnoreCase)) { return $true }
  }
  return $false
}

function Test-FileModeRegistration {
  param([string]$ServerConfigPath, [string]$CliConfigPath, [string]$RepositoryRoot)
  try {
    $serverEntries = @(Read-PluginEntries $ServerConfigPath)
    $cliEntries = @(Read-PluginEntries $CliConfigPath)
    foreach ($entry in $serverEntries) {
      if ($entry -is [string] -and $cliEntries -ccontains $entry -and
          (Test-FilePluginEntry @($entry) $RepositoryRoot)) { return $true }
    }
    return $false
  } catch { return $false }
}

# Run the installed SDK's resolver without importing/loading plugin entries. Bun executes in this
# repository so fixture roots can use the same SDK without acquiring dependencies or host config.
function Test-HostEntrypoints {
  param([string]$RepositoryRoot, [string]$SdkRepositoryRoot)
  $resolverSource = @'
import { Host } from "@opencode/plugin/host";
const entrypoints = Host.resolve({ directory: process.argv[1] });
if (!entrypoints.server || !entrypoints.tui) {
  console.error(`missing server=${!entrypoints.server} tui=${!entrypoints.tui}`);
  process.exit(1);
}
console.log(`server=${entrypoints.server} tui=${entrypoints.tui}`);
'@
  try {
    Push-Location $SdkRepositoryRoot
    try {
      $resolverOutput = (bun -e $resolverSource $RepositoryRoot 2>&1 | Out-String).Trim()
      $resolverExit = $LASTEXITCODE
    } finally { Pop-Location }
    return [pscustomobject]@{ Succeeded = ($resolverExit -eq 0); Detail = "exit=$resolverExit $resolverOutput" }
  } catch {
    return [pscustomobject]@{ Succeeded = $false; Detail = "bun/SDK resolver launch failed: $($_.Exception.Message)" }
  }
}

function Test-TrackedTree {
  param([string]$RepositoryRoot, [string]$InstalledPackage, [string]$Tree)
  if (-not $InstalledPackage -or -not (Test-Path -LiteralPath $InstalledPackage -PathType Container)) { return $false }
  try {
    $trackedPaths = @(git -C $RepositoryRoot -c core.quotepath=false ls-files -- $Tree)
    if ($LASTEXITCODE -ne 0 -or $trackedPaths.Count -eq 0) { return $false }
    foreach ($relativePath in $trackedPaths) {
      $localPath = Join-Path $RepositoryRoot $relativePath
      $installedPath = Join-Path $InstalledPackage $relativePath
      if (-not (Test-Path -LiteralPath $localPath -PathType Leaf) -or
          -not (Test-Path -LiteralPath $installedPath -PathType Leaf)) { return $false }
      if ((Get-FileHash -LiteralPath $localPath -Algorithm SHA256).Hash -ne
          (Get-FileHash -LiteralPath $installedPath -Algorithm SHA256).Hash) { return $false }
    }
    return $true
  } catch { return $false }
}

# dist/ 是发布构建产物，可能未被 git 跟踪；不能只依赖 tracked src/scripts 或 exports 存在。
function Test-DeliveredTuiFiles {
  param([string]$RepositoryRoot, [string]$InstalledPackage, [string]$TuiExportTarget)
  if (-not $InstalledPackage -or -not $TuiExportTarget) { return $false }
  foreach ($relativePath in @($TuiExportTarget, 'tui.js')) {
    $localPath = Join-Path $RepositoryRoot $relativePath
    $installedPath = Join-Path $InstalledPackage $relativePath
    if (-not (Test-Path -LiteralPath $localPath -PathType Leaf) -or
        -not (Test-Path -LiteralPath $installedPath -PathType Leaf)) { return $false }
    if ((Get-FileHash -LiteralPath $localPath -Algorithm SHA256).Hash -ne
        (Get-FileHash -LiteralPath $installedPath -Algorithm SHA256).Hash) { return $false }
  }
  return $true
}

function Invoke-BunRegression {
  param([string]$RepositoryRoot, [string]$TestPath, [switch]$UseTestRunner)
  $testOutput = ''
  $testExit = -1
  $testCommand = if ($UseTestRunner) { "bun test $TestPath" } else { "bun $TestPath" }
  try {
    Push-Location $RepositoryRoot
    try {
      if ($UseTestRunner) {
        $testOutput = (bun test $TestPath 2>&1 | Out-String)
      } else {
        $testOutput = (bun $TestPath 2>&1 | Out-String)
      }
      $testExit = $LASTEXITCODE
    } finally { Pop-Location }
    if ($UseTestRunner) {
      $passCount = ([regex]::Matches($testOutput, '(?m)^\s*[1-9]\d* pass\b')).Count
      $failCount = ([regex]::Matches($testOutput, '(?m)^\s*[1-9]\d* fail\b')).Count
    } else {
      $passCount = ([regex]::Matches($testOutput, '(?m)^\s*PASS\b')).Count
      $failCount = ([regex]::Matches($testOutput, '(?m)^\s*FAIL\b')).Count
    }
    Assert-Check "$testCommand passes" ($testExit -eq 0 -and $passCount -gt 0 -and $failCount -eq 0) "exit=$testExit PASS=$passCount FAIL=$failCount"
  } catch {
    Assert-Check "$testCommand passes" $false "bun launch failed: $($_.Exception.Message)"
  }
}

function Invoke-DevelopmentSmoke {
  param([string]$RepositoryRoot)
  $smokeExit = -1
  $smokeOutput = ''
  try {
    Push-Location $RepositoryRoot
    try {
      $smokeOutput = (bun scripts/dev-smoke.ts 2>&1 | Out-String)
      $smokeExit = $LASTEXITCODE
    } finally { Pop-Location }
    $passCount = ([regex]::Matches($smokeOutput, '(?m)^\s*PASS\b')).Count
    $failCount = ([regex]::Matches($smokeOutput, '(?m)^\s*FAIL\b')).Count
    Assert-Check 'dev-smoke passes under bun (synthetic matching p95)' ($smokeExit -eq 0 -and $passCount -gt 0 -and $failCount -eq 0) "exit=$smokeExit PASS=$passCount FAIL=$failCount; real DB not required"
  } catch {
    Assert-Check 'dev-smoke passes under bun (synthetic matching p95)' $false "bun launch failed: $($_.Exception.Message)"
  }
}

# git rev-parse 失败 (非 git 仓库 / 未推送) 时返回空串, 由调用方判 FAIL, 不让脚本崩。
function Read-GitShortRef {
  param([string]$RepositoryRoot, [string]$Ref)
  try {
    $refOutput = git -C $RepositoryRoot rev-parse --short $Ref 2>$null
    if ($LASTEXITCODE -ne 0) { return "" }
    return ($refOutput | Select-Object -First 1).Trim()
  } catch { return "" }
}

# 最新的完整安装 stamp (进行中的部分安装尚无 node_modules)。
function Resolve-InstalledPackage {
  param([string]$CacheRoot)
  if (-not (Test-Path -LiteralPath $CacheRoot -PathType Container)) { return $null }
  $stamps = Get-ChildItem $CacheRoot -Directory -Filter "git-opencode-history-ghost-*" |
    ForEach-Object { Get-ChildItem $_.FullName -Directory } |
    Sort-Object Name -Descending
  foreach ($stamp in $stamps) {
    $packageDir = Join-Path $stamp.FullName "node_modules\opencode-history-ghost"
    if (Test-Path (Join-Path $packageDir "package.json")) { return $packageDir }
  }
  return $null
}

# plugin list 行里的 commit; 剥离 ANSI 颜色码后取首个 7 位以上十六进制串。
function Read-ListedCommit {
  $listLine = (opencode plugin list | Select-String -Pattern "history-ghost" | Select-Object -First 1).Line
  if (-not $listLine) { return $null }
  $plainLine = $listLine -replace "$([char]27)\[[0-9;]*m", ""
  foreach ($token in ($plainLine -split "\s+")) {
    if ($token -match "^[0-9a-f]{7,}$") { return $token }
  }
  return $null
}

if ($Mode -ne "file" -and $Mode -ne "github") {
  Write-Output ("FAIL  unknown mode '$Mode' (expected 'file' or 'github')")
  exit 1
}

$packageJson = Get-Content (Join-Path $repoRoot "package.json") -Raw -Encoding UTF8 | ConvertFrom-Json
$expectedVersion = $packageJson.version

$hostConfigPath = Join-Path $env:USERPROFILE ".config\opencode\opencode.json"
$pluginEntries = @()
$configParseError = $null
try { $pluginEntries = @(Read-PluginEntries $hostConfigPath) }
catch { $configParseError = $_.Exception.Message }

if ($Mode -eq "file") {
  # --- file:// 本地模式: 检查服务端与 TUI 双注册、静态构建和自动回归；不证明宿主实际加载 ---

  # 1. 两个 plugins 数组都必须包含指向现存本仓库目录的 file URI；任一缺失/无效即 FAIL。
  $cliConfigPath = Join-Path $env:USERPROFILE ".config\opencode\cli.json"
  Assert-Check "server opencode.json and v2 TUI cli.json register this repo via file:// entries" (Test-FileModeRegistration $hostConfigPath $cliConfigPath $repoRoot)

  # 2. package.json exports["."] 与 exports["./tui"] 指向的文件真实存在
  $rootExportTarget = $packageJson.exports."."
  $tuiExportTarget = $packageJson.exports."./tui"
  $rootExportExists = ($null -ne $rootExportTarget) -and (Test-Path (Join-Path $repoRoot $rootExportTarget))
  $tuiExportExists = ($null -ne $tuiExportTarget) -and (Test-Path (Join-Path $repoRoot $tuiExportTarget))
  Assert-Check "package.json export targets exist" ($rootExportExists -and $tuiExportExists) ".=$rootExportTarget ./tui=$tuiExportTarget"

  # Root file URI uses Host.resolve({directory}) (index/tui probes), not package exports.
  # This checks resolution only: no Host.load, CLI invocation, history read or host mutation.
  # The separate entry-resolution Bun test loads under the local SDK, not the real host's
  # dependency graph; neither check proves that OpenTUI can be imported in the live TUI.
  $resolvedEntrypoints = Test-HostEntrypoints $repoRoot $repoRoot
  Assert-Check "local @opencode/plugin Host.resolve finds root server and tui" $resolvedEntrypoints.Succeeded "$($resolvedEntrypoints.Detail); 仅入口可解析，不证明真实宿主模块依赖可导入"

  # 3. 入口 TSX 转换与本地依赖图构建分别校验；仅后者带 --bundle。
  # V1: npx 缺失等 native 调用异常 → catch 输出 FAIL 行而非脚本崩溃。
  # V2: --yes 防新机首跑 "Ok to proceed?" 交互式挂起。
  # V5: 临时产物在 finally 中清盘。
  $esbuildExit = -1
  $esbuildOutput = ""
  $esbuildLaunchError = $null
  $syntaxOutputPath = Join-Path (Join-Path $env:TEMP "opencode") "history-ghost-verify-syntax.js"
  Push-Location $repoRoot
  try {
    New-Item -ItemType Directory -Force -Path (Split-Path $syntaxOutputPath -Parent) | Out-Null
    $esbuildOutput = (npx --yes esbuild src/tui.tsx --loader:.tsx=tsx --jsx=automatic --log-level=error --outfile=$syntaxOutputPath 2>&1 | Out-String).Trim()
    $esbuildExit = $LASTEXITCODE
  } catch {
    $esbuildLaunchError = $_.Exception.Message
  } finally {
    Pop-Location
    if (Test-Path $syntaxOutputPath) { Remove-Item $syntaxOutputPath -Force -ErrorAction SilentlyContinue }
  }
  if ($esbuildOutput) { Write-Output ("esbuild said: " + $esbuildOutput) }
  if ($esbuildLaunchError) {
    Assert-Check "入口 TSX 语法转换成功" $false "npx launch failed: $esbuildLaunchError"
  } else {
    Assert-Check "入口 TSX 语法转换成功" ($esbuildExit -eq 0) "exit=$esbuildExit"
  }

  # External SDK / Node builtins are resolved by the host, not by this build.
  # This checks local import graph resolution only, NOT SDK compatibility or TUI runtime loading.
  $graphExit = -1
  $graphOutput = ""
  $graphLaunchError = $null
  $graphOutputPath = Join-Path (Join-Path $env:TEMP "opencode") "history-ghost-verify-graph.js"
  Push-Location $repoRoot
  try {
    New-Item -ItemType Directory -Force -Path (Split-Path $graphOutputPath -Parent) | Out-Null
    $graphOutput = (npx --yes esbuild src/tui.tsx --bundle --platform=node --loader:.tsx=tsx --jsx=automatic --external:@opentui/core --external:@opentui/solid --external:@opencode/plugin --external:node:* --log-level=error --outfile=$graphOutputPath 2>&1 | Out-String).Trim()
    $graphExit = $LASTEXITCODE
  } catch {
    $graphLaunchError = $_.Exception.Message
  } finally {
    Pop-Location
    if (Test-Path $graphOutputPath) { Remove-Item $graphOutputPath -Force -ErrorAction SilentlyContinue }
  }
  if ($graphOutput) { Write-Output ("esbuild graph said: " + $graphOutput) }
  if ($graphLaunchError) {
    Assert-Check "本地依赖图构建成功（SDK/Node 外置，非宿主运行验证）" $false "npx launch failed: $graphLaunchError"
  } else {
    Assert-Check "本地依赖图构建成功（SDK/Node 外置，非宿主运行验证）" ($graphExit -eq 0) "exit=$graphExit"
  }

  # 4. lockfile 根条目 peerDependencies 不含 solid-js (npm ci EUSAGE 回归防护)
  # lockfile 根条目键名是空串 "", PSObject 不支持空键名属性 — 必须用 -AsHashTable。
  $lockfileJson = Get-Content (Join-Path $repoRoot "package-lock.json") -Raw -Encoding UTF8 | ConvertFrom-Json -AsHashTable
  $rootPeerNames = @($lockfileJson["packages"][""]["peerDependencies"].Keys)
  Assert-Check "lockfile root peerDependencies has no solid-js" ($rootPeerNames -notcontains "solid-js") "rootPeers=$($rootPeerNames -join ',')"

  # 5. 关键根文件齐全, .gitignore 覆盖 node_modules/
  $requiredRootFiles = @("LICENSE", "README.md", "DESIGN.md", "tasks.md", ".gitignore")
  $missingRootFiles = @($requiredRootFiles | Where-Object { -not (Test-Path (Join-Path $repoRoot $_)) })
  $gitignoreText = Get-Content (Join-Path $repoRoot ".gitignore") -Raw -Encoding UTF8
  Assert-Check "required root files present" ($missingRootFiles.Count -eq 0 -and $gitignoreText -match "node_modules/") "missing=$($missingRootFiles -join ',')"
} else {
  # --- github 模式: 发布链端到端验证 ---------------------------------------------------

  $localHead = Read-GitShortRef $repoRoot "HEAD"
  # 动态解析当前分支（仓库可能用 master/main 等任意默认分支名，不硬编码）
  $currentBranch = ""
  try { $currentBranch = @(git -C $repoRoot symbolic-ref --short HEAD 2>$null)[0] } catch { $currentBranch = "" }
  $originHead = if ($currentBranch) { Read-GitShortRef $repoRoot "origin/$currentBranch" } else { "" }
  Assert-Check "local HEAD is pushed (HEAD == origin/$currentBranch)" ($localHead -ne "" -and $currentBranch -ne "" -and $localHead -eq $originHead) "HEAD=$localHead branch=$currentBranch origin=$originHead"

  # opencode plugin update 返回早于落盘 — 下面对注册表与 stamp 轮询
  $updateOutput = ''
  $updateExit = -1
  $updateError = $null
  Push-Location $env:USERPROFILE
  try {
    $updateOutput = (opencode plugin update $PluginId 2>&1 | Out-String).Trim()
    $updateExit = $LASTEXITCODE
  } catch {
    $updateError = $_.Exception.Message
  } finally {
    Pop-Location
  }
  Write-Output ("update: " + $updateOutput)
  Assert-Check "opencode plugin update succeeds" ($updateExit -eq 0 -and -not $updateError) "exit=$updateExit error=$updateError"

  # V3: 非 git 仓库 / 无推送 (localHead 为空) — plugin list 轮询必然空转满
  # 超时, 直接 FAIL 并跳过轮询。
  $installedCommit = $null
  if ($localHead -eq "") {
    Assert-Check "plugin list shows the pushed commit" $false "not a git repo / nothing pushed (HEAD empty); poll skipped"
  } else {
    $installDeadline = (Get-Date).AddSeconds($InstallTimeoutSeconds)
    while ((Get-Date) -lt $installDeadline) {
      $installedCommit = Read-ListedCommit
      if ($installedCommit -eq $localHead) { break }
      Start-Sleep -Seconds 2
    }
    Assert-Check "plugin list shows the pushed commit" ($installedCommit -eq $localHead) "installed=$installedCommit expected=$localHead"
  }

  $cacheRoot = Join-Path $env:USERPROFILE ".cache\opencode\npm"
  $installedPkg = $null
  $installedVersion = $null
  $diskDeadline = (Get-Date).AddSeconds(30)
  while ((Get-Date) -lt $diskDeadline) {
    $installedPkg = Resolve-InstalledPackage $cacheRoot
    if ($installedPkg) {
      $installedVersion = (Get-Content (Join-Path $installedPkg "package.json") -Raw -Encoding UTF8 | ConvertFrom-Json).version
      if ($installedVersion -eq $expectedVersion) { break }
    }
    Start-Sleep -Seconds 2
  }
  Assert-Check "on-disk installed version matches package.json" ($installedVersion -eq $expectedVersion) "installed=$installedVersion expected=$expectedVersion"

  Assert-Check "installed tracked src files match repo SHA256" (Test-TrackedTree $repoRoot $installedPkg 'src')
  Assert-Check "installed tracked scripts files match repo SHA256" (Test-TrackedTree $repoRoot $installedPkg 'scripts')

  $tuiExportTarget = $null
  if ($installedPkg) {
    try {
      $installedPkgJson = Get-Content (Join-Path $installedPkg "package.json") -Raw -Encoding UTF8 | ConvertFrom-Json
      if ($installedPkgJson.exports -is [System.Management.Automation.PSObject]) {
        $tuiExportTarget = $installedPkgJson.exports."./tui"
      }
    } catch { $tuiExportTarget = $null }
  }
  $tuiExportMatches = Test-DeliveredTuiFiles $repoRoot $installedPkg $tuiExportTarget
  Assert-Check "installed TUI bundle and root bridge match local delivered files" $tuiExportMatches "export=$tuiExportTarget"

  Assert-Check "plugin registered in opencode.json plugins array" ((-not $configParseError) -and ($pluginEntries -ccontains $PluginId)) $(if ($configParseError) { "opencode.json parse error: $configParseError" } else { "expected=$PluginId" })
}

# 两种模式均执行匹配性能冒烟与隔离的 Bun 回归；真实 DB 仅观测，不等于宿主 TUI 手测。
Invoke-DevelopmentSmoke $repoRoot
Invoke-BunRegression $repoRoot 'test/ghost-core.test.ts'
Invoke-BunRegression $repoRoot 'test/editor-bridge-regression.test.ts'
Invoke-BunRegression $repoRoot 'test/tui-load-diagnostic.test.ts'
Invoke-BunRegression $repoRoot 'test/caret-prefix-accept.test.ts'
Invoke-BunRegression $repoRoot 'test/history-completeness.test.ts'
Invoke-BunRegression $repoRoot 'test/ghost-remount.test.ts'
Invoke-BunRegression $repoRoot 'test/composer-identity.test.ts'
Invoke-BunRegression $repoRoot 'test/history-scan-performance.test.ts'
Invoke-BunRegression $repoRoot 'test/entry-resolution.test.ts' -UseTestRunner
Invoke-BunRegression $repoRoot 'test/tui-delivery.test.ts' -UseTestRunner
Invoke-BunRegression $repoRoot 'test/history-reassessment.test.ts' -UseTestRunner

Write-Output "----"
if ($script:failures -eq 0) {
  Write-Output ("VERIFY OK — v$expectedVersion mode=$Mode all checks passed")
  exit 0
}
Write-Output ("VERIFY FAILED — $script:failures check(s) failed")
exit 1
