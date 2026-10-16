# verify-install.ps1 — opencode-history-ghost 一键安装自验证。
# Run from anywhere:  pwsh <plugin>/scripts/verify-install.ps1
#
# 双模式验证链:
#   file (默认, file:// 本地安装): opencode.json file:// 注册 -> package.json
#        exports 目标存在 -> esbuild 语法零报错 -> dev-smoke 全 PASS ->
#        lockfile 根条目 peerDependencies 无 solid-js 回归 -> 根文件齐全。
#   github (发布后): HEAD 已推送 -> opencode plugin update -> plugin list
#        commit 一致 -> 落盘 stamp 版本与 package.json 一致 -> src/scripts
#        文件树镜像仓库 -> tui exports 目标存在于 stamp -> opencode.json 注册。
# 每项检查输出一行 PASS/FAIL; 仅当全部通过时 exit 0。
#
# 注意: 本目录在 file:// 开发态不是 git 仓库 — file 模式完全不调用 git,
# 不因此报错; github 模式才需要 git (HEAD/origin 比对与 tracked 文件计数),
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

function Count-Files {
  param([string]$Directory)
  if (-not (Test-Path $Directory)) { return 0 }
  return @(Get-ChildItem $Directory -Recurse -File).Count
}

# github 模式专用: 仓库里 git-tracked 的文件数 (未跟踪的本地产物不应干扰镜像比对)。
function Count-TrackedFiles {
  param([string]$RepositoryRoot, [string]$Path)
  $trackedPaths = git -C $RepositoryRoot ls-files -- $Path
  if (-not $trackedPaths) { return 0 }
  return @($trackedPaths).Count
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
$hostConfig = if (Test-Path $hostConfigPath) {
  Get-Content $hostConfigPath -Raw -Encoding UTF8
} else { "" }

if ($Mode -eq "file") {
  # --- file:// 本地模式: 验证宿主挂载点与插件自身可加载、可运行 ----------------------

  # 1. opencode.json 里存在指向本插件的 file:// 条目
  # V4: 配置解析失败不再静默 — parse 错误写进 Detail, FAIL 行可见真实原因。
  $pluginEntries = @()
  $configParseError = $null
  try {
    $pluginEntries = @((Get-Content $hostConfigPath -Raw -Encoding UTF8 | ConvertFrom-Json).plugins)
  } catch { $configParseError = $_.Exception.Message }
  $fileEntry = $pluginEntries | Where-Object { $_ -like "file*" -and $_ -like "*opencode-history-ghost*" } | Select-Object -First 1
  $entryDetail = if ($configParseError) { "opencode.json parse error: $configParseError" } else { "entry=$fileEntry" }
  Assert-Check "opencode.json registers this plugin via file:// entry" ($null -ne $fileEntry) $entryDetail

  # 2. package.json exports["."] 与 exports["./tui"] 指向的文件真实存在
  $rootExportTarget = $packageJson.exports."."
  $tuiExportTarget = $packageJson.exports."./tui"
  $rootExportExists = ($null -ne $rootExportTarget) -and (Test-Path (Join-Path $repoRoot $rootExportTarget))
  $tuiExportExists = ($null -ne $tuiExportTarget) -and (Test-Path (Join-Path $repoRoot $tuiExportTarget))
  Assert-Check "package.json export targets exist" ($rootExportExists -and $tuiExportExists) ".=$rootExportTarget ./tui=$tuiExportTarget"

  # 3. esbuild 语法校验零报错 (与 README 开发节同款命令)。
  # V1: npx 缺失等 native 调用异常 → catch 输出 FAIL 行而非脚本崩溃。
  # V2: --yes 防新机首跑 "Ok to proceed?" 交互式挂起。
  # V5: 临时 bundle 产物在 finally 中清盘。
  $esbuildExit = -1
  $esbuildOutput = ""
  $esbuildLaunchError = $null
  $bundleOutputPath = Join-Path (Join-Path $env:TEMP "opencode") "history-ghost-verify-bundle.js"
  Push-Location $repoRoot
  try {
    New-Item -ItemType Directory -Force -Path (Split-Path $bundleOutputPath -Parent) | Out-Null
    $esbuildOutput = (npx --yes esbuild src/tui.tsx --loader:.tsx=tsx --jsx=automatic --log-level=error --outfile=$bundleOutputPath 2>&1 | Out-String).Trim()
    $esbuildExit = $LASTEXITCODE
  } catch {
    $esbuildLaunchError = $_.Exception.Message
  } finally {
    Pop-Location
    if (Test-Path $bundleOutputPath) { Remove-Item $bundleOutputPath -Force -ErrorAction SilentlyContinue }
  }
  if ($esbuildOutput) { Write-Output ("esbuild said: " + $esbuildOutput) }
  if ($esbuildLaunchError) {
    Assert-Check "esbuild bundles src/tui.tsx with zero errors" $false "npx launch failed: $esbuildLaunchError"
  } else {
    Assert-Check "esbuild bundles src/tui.tsx with zero errors" ($esbuildExit -eq 0) "exit=$esbuildExit"
  }

  # 4. dev-smoke 全 PASS (脚本对 FAIL 只打日志不退非零, 必须同时看退出码与输出)
  # V1: bun 缺失时 catch 输出 FAIL 行而非脚本崩溃。
  $smokeExit = -1
  $smokeOutput = ""
  $smokeLaunchError = $null
  Push-Location $repoRoot
  try {
    $smokeOutput = (bun scripts/dev-smoke.ts 2>&1 | Out-String)
    $smokeExit = $LASTEXITCODE
  } catch {
    $smokeLaunchError = $_.Exception.Message
  } finally {
    Pop-Location
  }
  if ($smokeLaunchError) {
    Assert-Check "dev-smoke passes under bun" $false "bun launch failed: $smokeLaunchError"
  } else {
    $smokeFailedTokenCount = ([regex]::Matches($smokeOutput, "FAIL")).Count
    Assert-Check "dev-smoke passes under bun" ($smokeExit -eq 0 -and $smokeFailedTokenCount -eq 0) "exit=$smokeExit FAIL-tokens=$smokeFailedTokenCount"
  }

  # 5. lockfile 根条目 peerDependencies 不含 solid-js (npm ci EUSAGE 回归防护)
  # lockfile 根条目键名是空串 "", PSObject 不支持空键名属性 — 必须用 -AsHashTable。
  $lockfileJson = Get-Content (Join-Path $repoRoot "package-lock.json") -Raw -Encoding UTF8 | ConvertFrom-Json -AsHashTable
  $rootPeerNames = @($lockfileJson["packages"][""]["peerDependencies"].Keys)
  Assert-Check "lockfile root peerDependencies has no solid-js" ($rootPeerNames -notcontains "solid-js") "rootPeers=$($rootPeerNames -join ',')"

  # 6. 关键根文件齐全, .gitignore 覆盖 node_modules/
  $requiredRootFiles = @("LICENSE", "README.md", "DESIGN.md", "tasks.md", ".gitignore")
  $missingRootFiles = @($requiredRootFiles | Where-Object { -not (Test-Path (Join-Path $repoRoot $_)) })
  $gitignoreText = Get-Content (Join-Path $repoRoot ".gitignore") -Raw -Encoding UTF8
  Assert-Check "required root files present" ($missingRootFiles.Count -eq 0 -and $gitignoreText -match "node_modules/") "missing=$($missingRootFiles -join ',')"
} else {
  # --- github 模式: 发布链端到端验证 ---------------------------------------------------

  $localHead = Read-GitShortRef $repoRoot "HEAD"
  $originHead = Read-GitShortRef $repoRoot "origin/main"
  Assert-Check "local HEAD is pushed (HEAD == origin/main)" ($localHead -ne "" -and $localHead -eq $originHead) "HEAD=$localHead origin=$originHead"

  $expectedSrcCount = Count-TrackedFiles $repoRoot "src"
  $expectedScriptsCount = Count-TrackedFiles $repoRoot "scripts"

  # opencode plugin update 返回早于落盘 — 下面对注册表与 stamp 轮询
  Push-Location $env:USERPROFILE
  try {
    $updateOutput = (opencode plugin update $PluginId 2>&1 | Out-String).Trim()
  } finally {
    Pop-Location
  }
  Write-Output ("update: " + $updateOutput)

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

  $installedSrcCount = if ($installedPkg) { Count-Files (Join-Path $installedPkg "src") } else { -1 }
  $installedScriptsCount = if ($installedPkg) { Count-Files (Join-Path $installedPkg "scripts") } else { -1 }
  Assert-Check "installed src tree mirrors the repo" ($installedSrcCount -eq $expectedSrcCount) "installed=$installedSrcCount repo=$expectedSrcCount"
  Assert-Check "installed scripts tree mirrors the repo" ($installedScriptsCount -eq $expectedScriptsCount) "installed=$installedScriptsCount repo=$expectedScriptsCount"

  $tuiExportTarget = $null
  if ($installedPkg) {
    try {
      $installedPkgJson = Get-Content (Join-Path $installedPkg "package.json") -Raw -Encoding UTF8 | ConvertFrom-Json
      if ($installedPkgJson.exports -is [System.Management.Automation.PSObject]) {
        $tuiExportTarget = $installedPkgJson.exports."./tui"
      }
    } catch { $tuiExportTarget = $null }
  }
  $tuiExportExists = ($null -ne $tuiExportTarget) -and (Test-Path (Join-Path $installedPkg $tuiExportTarget))
  Assert-Check "tui export target exists in stamp" ($tuiExportExists) "export=$tuiExportTarget"

  Assert-Check "plugin registered in opencode.json" ($hostConfig.Contains($PluginId))
}

Write-Output "----"
if ($script:failures -eq 0) {
  Write-Output ("VERIFY OK — v$expectedVersion mode=$Mode all checks passed")
  exit 0
}
Write-Output ("VERIFY FAILED — $script:failures check(s) failed")
exit 1
