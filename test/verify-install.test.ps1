# Isolated verifier predicate regressions. No host configuration or plugin update is touched.
$ErrorActionPreference = 'Stop'
$repositoryRoot = Split-Path $PSScriptRoot -Parent
$verifierPath = Join-Path $repositoryRoot 'scripts/verify-install.ps1'
$parseErrors = $null
$syntaxTree = [System.Management.Automation.Language.Parser]::ParseFile($verifierPath, [ref]$null, [ref]$parseErrors)
if ($parseErrors.Count -gt 0) { throw "verifier syntax errors: $($parseErrors -join '; ')" }
function Test-EsbuildVerifierContract {
  param([string]$ScriptText)
  $scriptParseErrors = $null
  $scriptAst = [System.Management.Automation.Language.Parser]::ParseInput($ScriptText, [ref]$null, [ref]$scriptParseErrors)
  if ($scriptParseErrors.Count -gt 0) { return $false }
  $esbuildCommands = @($scriptAst.FindAll({
    param($syntaxNode)
    $syntaxNode -is [System.Management.Automation.Language.CommandAst] -and
      $syntaxNode.GetCommandName() -eq 'npx' -and
      $syntaxNode.Extent.Text -match '\besbuild\b'
  }, $false))
  if ($esbuildCommands.Count -ne 2) { return $false }
  $syntaxCommand = @($esbuildCommands | Where-Object { $_.Extent.Text -match '--outfile=\$syntaxOutputPath\b' })
  $graphCommand = @($esbuildCommands | Where-Object { $_.Extent.Text -match '--outfile=\$graphOutputPath\b' })
  if ($syntaxCommand.Count -ne 1 -or $graphCommand.Count -ne 1) { return $false }
  if ($syntaxCommand[0].Extent.Text -match '--bundle|--external:' -or
      $graphCommand[0].Extent.Text -notmatch '(?<!\S)--bundle(?!\S)') { return $false }
  foreach ($external in @('--external:@opentui/core', '--external:@opentui/solid', '--external:@opencode/plugin', '--external:node:*')) {
    if (-not $graphCommand[0].Extent.Text.Contains($external)) { return $false }
  }
  if ($ScriptText -notmatch 'Assert-Check "入口 TSX 语法转换成功"' -or
      $ScriptText -notmatch 'Assert-Check "本地依赖图构建成功（SDK/Node 外置，非宿主运行验证）"' -or
      $ScriptText -match 'esbuild bundles src/tui.tsx with zero errors') { return $false }
  foreach ($outputPath in @('syntaxOutputPath', 'graphOutputPath')) {
    $cleanupStatement = 'if (Test-Path ${0}) {{ Remove-Item ${0} -Force' -f $outputPath
    if ($ScriptText -notmatch [regex]::Escape($cleanupStatement)) { return $false }
  }
  return $true
}
$verifierText = Get-Content -LiteralPath $verifierPath -Raw -Encoding UTF8
if (-not (Test-EsbuildVerifierContract $verifierText)) { throw 'FAIL esbuild verifier contract' }
Write-Output 'PASS separate TSX conversion and externalized dependency graph checks with cleanup'
function Test-HostResolverVerifierContract {
  param([string]$ScriptText)
  return ($ScriptText.Contains('Host.resolve({ directory: process.argv[1] })') -and
    $ScriptText.Contains('if (!entrypoints.server || !entrypoints.tui)') -and
    $ScriptText.Contains('Assert-Check "local @opencode/plugin Host.resolve finds root server and tui" $resolvedEntrypoints.Succeeded'))
}
if (-not (Test-HostResolverVerifierContract $verifierText)) { throw 'FAIL root resolver verifier contract' }
$resolverBypassFixture = $verifierText.Replace('Assert-Check "local @opencode/plugin Host.resolve finds root server and tui" $resolvedEntrypoints.Succeeded',
  'Assert-Check "local @opencode/plugin Host.resolve finds root server and tui" $true')
if (Test-HostResolverVerifierContract $resolverBypassFixture) { throw 'FAIL bypassed root resolver check accepted' }
Write-Output 'PASS root resolver check rejects a bypassed assertion'
foreach ($modifiedText in @(
  $verifierText.Replace('--bundle --platform=node', '--platform=node'),
  $verifierText.Replace('--external:@opentui/core', ''),
  $verifierText.Replace('入口 TSX 语法转换成功', 'esbuild bundles src/tui.tsx with zero errors'),
  $verifierText.Replace('if (Test-Path $graphOutputPath) { Remove-Item $graphOutputPath -Force', 'if (Test-Path $graphOutputPath) { Write-Output $graphOutputPath')
)) {
  if (Test-EsbuildVerifierContract $modifiedText) { throw 'FAIL esbuild verifier contract accepted a negative fixture' }
}
Write-Output 'PASS esbuild verifier contract rejects missing bundle, external, accurate label or cleanup'
$definitions = $syntaxTree.FindAll({ param($syntaxNode) $syntaxNode -is [System.Management.Automation.Language.FunctionDefinitionAst] }, $false)
foreach ($definition in $definitions) { . ([scriptblock]::Create($definition.Extent.Text)) }
$regressionInvocations = @($syntaxTree.FindAll({
  param($syntaxNode)
  $syntaxNode -is [System.Management.Automation.Language.CommandAst] -and
    $syntaxNode.GetCommandName() -eq 'Invoke-BunRegression'
}, $false) | Where-Object { $_.Parent -isnot [System.Management.Automation.Language.FunctionDefinitionAst] })
$requiredRegressionPaths = @(
  'test/ghost-core.test.ts',
  'test/editor-bridge-regression.test.ts',
  'test/tui-load-diagnostic.test.ts',
  'test/caret-prefix-accept.test.ts',
  'test/history-completeness.test.ts',
  'test/ghost-remount.test.ts',
  'test/composer-identity.test.ts',
  'test/history-scan-performance.test.ts',
  'test/entry-resolution.test.ts',
  'test/tui-delivery.test.ts',
  'test/history-reassessment.test.ts'
)
function Test-RequiredBunRegressions {
  param([System.Management.Automation.Language.Ast]$ScriptAst, [string[]]$RequiredPaths)
  $invocations = @($ScriptAst.FindAll({
    param($syntaxNode)
    $syntaxNode -is [System.Management.Automation.Language.CommandAst] -and
      $syntaxNode.GetCommandName() -eq 'Invoke-BunRegression'
  }, $false) | Where-Object { $_.Parent -isnot [System.Management.Automation.Language.FunctionDefinitionAst] })
  if ($invocations.Count -ne $RequiredPaths.Count) { return $false }
  foreach ($requiredPath in $RequiredPaths) {
    $usesTestRunner = $requiredPath -in @('test/entry-resolution.test.ts', 'test/tui-delivery.test.ts', 'test/history-reassessment.test.ts')
    $expectedElementCount = if ($usesTestRunner) { 4 } else { 3 }
    if (@($invocations | Where-Object {
      $_.CommandElements.Count -eq $expectedElementCount -and $_.CommandElements[2].Value -eq $requiredPath -and
        (-not $usesTestRunner -or $_.CommandElements[3].Extent.Text -eq '-UseTestRunner')
    }).Count -ne 1) { return $false }
  }
  return $true
}
if (-not (Test-RequiredBunRegressions $syntaxTree $requiredRegressionPaths)) { throw 'FAIL independent Bun regressions contract' }
if ($regressionInvocations.Count -ne $requiredRegressionPaths.Count) {
  throw "FAIL expected exactly $($requiredRegressionPaths.Count) independent Bun regressions, found $($regressionInvocations.Count)"
}
foreach ($testPath in $requiredRegressionPaths) {
  $usesTestRunner = $testPath -in @('test/entry-resolution.test.ts', 'test/tui-delivery.test.ts', 'test/history-reassessment.test.ts')
  $expectedElementCount = if ($usesTestRunner) { 4 } else { 3 }
  if (@($regressionInvocations | Where-Object {
    $_.CommandElements.Count -eq $expectedElementCount -and $_.CommandElements[2].Value -eq $testPath -and
      (-not $usesTestRunner -or $_.CommandElements[3].Extent.Text -eq '-UseTestRunner')
  }).Count -ne 1) {
    throw "FAIL distinct Bun regression invocation missing: $testPath"
  }
  Write-Output "PASS separate Bun regression: $testPath"
}
$missingPerformanceFixture = $verifierText.Replace("Invoke-BunRegression `$repoRoot 'test/history-scan-performance.test.ts'", '')
$fixtureErrors = $null
$fixtureAst = [System.Management.Automation.Language.Parser]::ParseInput($missingPerformanceFixture, [ref]$null, [ref]$fixtureErrors)
if ($fixtureErrors.Count -gt 0) { throw 'FAIL missing-performance fixture must remain syntactically valid' }
if (Test-RequiredBunRegressions $fixtureAst $requiredRegressionPaths) { throw 'FAIL missing performance regression fixture was accepted' }
Write-Output 'PASS missing performance regression is detected by independent-invocation predicate'
$deliveryInvocation = "Invoke-BunRegression `$repoRoot 'test/tui-delivery.test.ts' -UseTestRunner"
foreach ($deliveryFixture in @(
  $verifierText.Replace($deliveryInvocation, ''),
  $verifierText.Replace($deliveryInvocation, "Invoke-BunRegression `$repoRoot 'test/tui-delivery.test.ts'"),
  $verifierText.Replace($deliveryInvocation, "Invoke-BunRegression `$repoRoot 'test/tui-delivery.test.ts' -UnexpectedSwitch")
)) {
  $fixtureErrors = $null
  $fixtureAst = [System.Management.Automation.Language.Parser]::ParseInput($deliveryFixture, [ref]$null, [ref]$fixtureErrors)
  if ($fixtureErrors.Count -gt 0) { throw 'FAIL delivery fixture must remain syntactically valid' }
  if (Test-RequiredBunRegressions $fixtureAst $requiredRegressionPaths) { throw 'FAIL missing or malformed delivery regression fixture was accepted' }
}
Write-Output 'PASS missing or malformed delivery regression invocation is detected'
$reassessmentInvocation = "Invoke-BunRegression `$repoRoot 'test/history-reassessment.test.ts' -UseTestRunner"
foreach ($reassessmentFixture in @(
  $verifierText.Replace($reassessmentInvocation, ''),
  $verifierText.Replace($reassessmentInvocation, "Invoke-BunRegression `$repoRoot 'test/history-reassessment.test.ts'"),
  $verifierText.Replace($reassessmentInvocation, "Invoke-BunRegression `$repoRoot 'test/history-reassessment.test.ts' -UnexpectedSwitch")
)) {
  $fixtureErrors = $null
  $fixtureAst = [System.Management.Automation.Language.Parser]::ParseInput($reassessmentFixture, [ref]$null, [ref]$fixtureErrors)
  if ($fixtureErrors.Count -gt 0) { throw 'FAIL history reassessment fixture must remain syntactically valid' }
  if (Test-RequiredBunRegressions $fixtureAst $requiredRegressionPaths) { throw 'FAIL missing or malformed history reassessment regression fixture was accepted' }
}
Write-Output 'PASS missing or malformed history reassessment regression invocation is detected'
foreach ($invocation in $regressionInvocations) {
  $branch = $invocation.Parent
  while ($branch -and $branch -isnot [System.Management.Automation.Language.ScriptBlockAst]) {
    if ($branch -is [System.Management.Automation.Language.IfStatementAst]) {
      throw "FAIL Bun regression must run outside the mode branch: $($invocation.Extent.Text)"
    }
    $branch = $branch.Parent
  }
}
Write-Output 'PASS separate Bun regressions shared by file and github modes'
if (-not $verifierText.Contains('Test-DeliveredTuiFiles $repoRoot $installedPkg $tuiExportTarget')) {
  throw 'FAIL installed artifact must be validated rather than only checking the graph'
}
$smokeInvocations = @($syntaxTree.FindAll({
  param($syntaxNode)
  $syntaxNode -is [System.Management.Automation.Language.CommandAst] -and
    $syntaxNode.GetCommandName() -eq 'Invoke-DevelopmentSmoke'
}, $false))
if ($smokeInvocations.Count -ne 1) { throw 'FAIL both modes must share one development smoke invocation' }
Write-Output 'PASS development smoke invoked outside mode branch'

$fixtureRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("history-ghost-verifier-" + [guid]::NewGuid().ToString('N'))
$fixtureRepository = Join-Path $fixtureRoot 'opencode-history-ghost'
$otherRepository = Join-Path $fixtureRoot 'other-opencode-history-ghost'
$installedPackage = Join-Path $fixtureRoot 'installed'
$fixtureConfig = Join-Path $fixtureRoot 'opencode.json'
$fixtureCliConfig = Join-Path $fixtureRoot 'cli.json'
function Assert-Predicate {
  param([string]$Label, [bool]$Condition)
  if (-not $Condition) { throw "FAIL $Label" }
  Write-Output "PASS $Label"
}

try {
  foreach ($directory in @($fixtureRepository, $otherRepository, $installedPackage)) {
    New-Item -ItemType Directory -Path $directory -Force | Out-Null
  }
  $fileUri = ([uri]([System.IO.Path]::GetFullPath($fixtureRepository) + [System.IO.Path]::DirectorySeparatorChar)).AbsoluteUri
  $wrongUri = ([uri]([System.IO.Path]::GetFullPath($otherRepository) + [System.IO.Path]::DirectorySeparatorChar)).AbsoluteUri
  Assert-Predicate 'file URI points to normalized repo' (Test-FilePluginEntry @($fileUri) $fixtureRepository)
  Assert-Predicate 'wrong file URI with plugin name rejected' (-not (Test-FilePluginEntry @($wrongUri) $fixtureRepository))
  Assert-Predicate 'non-file URI rejected' (-not (Test-FilePluginEntry @('https://example.org/opencode-history-ghost') $fixtureRepository))
  @{ plugins = @($fileUri) } | ConvertTo-Json | Set-Content -LiteralPath $fixtureConfig -Encoding UTF8
  Assert-Predicate 'server-only registration rejected when TUI config missing' (-not (Test-FileModeRegistration $fixtureConfig $fixtureCliConfig $fixtureRepository))
  @{ plugins = @($fileUri) } | ConvertTo-Json | Set-Content -LiteralPath $fixtureCliConfig -Encoding UTF8
  Assert-Predicate 'both server and TUI file registrations accepted' (Test-FileModeRegistration $fixtureConfig $fixtureCliConfig $fixtureRepository)
  New-Item -ItemType Directory -Path (Join-Path $fixtureRepository 'src') -Force | Out-Null
  '{"name":"fixture-plugin","type":"module","exports":{".":"./src/index.ts","./tui":"./src/tui.tsx"}}' |
    Set-Content -LiteralPath (Join-Path $fixtureRepository 'package.json') -Encoding UTF8
  'export default {}' | Set-Content -LiteralPath (Join-Path $fixtureRepository 'src/index.ts') -Encoding UTF8
  'export default {}' | Set-Content -LiteralPath (Join-Path $fixtureRepository 'src/tui.tsx') -Encoding UTF8
  $fixturePackage = Get-Content -LiteralPath (Join-Path $fixtureRepository 'package.json') -Raw | ConvertFrom-Json
  Assert-Predicate 'fixture package exports targets exist' ((Test-Path -LiteralPath (Join-Path $fixtureRepository $fixturePackage.exports.'.')) -and
    (Test-Path -LiteralPath (Join-Path $fixtureRepository $fixturePackage.exports.'./tui')))
  $missingRootEntrypoints = Test-HostEntrypoints $fixtureRepository $repositoryRoot
  Assert-Predicate 'empty root rejected despite valid src exports and both file registrations' (-not $missingRootEntrypoints.Succeeded)
  Assert-Predicate 'fixture failure identifies both root entries' ($missingRootEntrypoints.Detail -match 'missing server=true tui=true')
  @{ plugins = @($fileUri.TrimEnd('/')) } | ConvertTo-Json | Set-Content -LiteralPath $fixtureCliConfig -Encoding UTF8
  Assert-Predicate 'different URI spellings in server and TUI rejected' (-not (Test-FileModeRegistration $fixtureConfig $fixtureCliConfig $fixtureRepository))
  $missingUri = ([uri]([System.IO.Path]::GetFullPath((Join-Path $fixtureRoot 'missing-repository')) + [System.IO.Path]::DirectorySeparatorChar)).AbsoluteUri
  @{ plugins = @($missingUri) } | ConvertTo-Json | Set-Content -LiteralPath $fixtureCliConfig -Encoding UTF8
  Assert-Predicate 'TUI file URI to missing directory rejected' (-not (Test-FileModeRegistration $fixtureConfig $fixtureCliConfig $fixtureRepository))
  @{ plugins = @($wrongUri) } | ConvertTo-Json | Set-Content -LiteralPath $fixtureCliConfig -Encoding UTF8
  Assert-Predicate 'TUI URI pointing elsewhere rejected' (-not (Test-FileModeRegistration $fixtureConfig $fixtureCliConfig $fixtureRepository))
  '{"plugins":"invalid"}' | Set-Content -LiteralPath $fixtureCliConfig -Encoding UTF8
  Assert-Predicate 'malformed TUI plugins array rejected' (-not (Test-FileModeRegistration $fixtureConfig $fixtureCliConfig $fixtureRepository))
  '{"plugins":[' | Set-Content -LiteralPath $fixtureCliConfig -Encoding UTF8
  Assert-Predicate 'invalid TUI JSON rejected' (-not (Test-FileModeRegistration $fixtureConfig $fixtureCliConfig $fixtureRepository))
  @{ plugins = @($fileUri) } | ConvertTo-Json | Set-Content -LiteralPath $fixtureCliConfig -Encoding UTF8
  @{ plugins = @($wrongUri) } | ConvertTo-Json | Set-Content -LiteralPath $fixtureConfig -Encoding UTF8
  Assert-Predicate 'server URI pointing elsewhere rejected' (-not (Test-FileModeRegistration $fixtureConfig $fixtureCliConfig $fixtureRepository))
  '{"unrelated":"github:dubuqiangu/opencode-history-ghost","plugins":["other"]}' | Set-Content -LiteralPath $fixtureConfig -Encoding UTF8
  $configuredEntries = @(Read-PluginEntries $fixtureConfig)
  Assert-Predicate 'github ID in unrelated field rejected' ($configuredEntries -cnotcontains 'github:dubuqiangu/opencode-history-ghost')
  '{"plugins":["github:dubuqiangu/opencode-history-ghost"]}' | Set-Content -LiteralPath $fixtureConfig -Encoding UTF8
  Assert-Predicate 'github exact plugin array accepted' (@(Read-PluginEntries $fixtureConfig) -ccontains 'github:dubuqiangu/opencode-history-ghost')
  '{"plugins":"github:dubuqiangu/opencode-history-ghost"}' | Set-Content -LiteralPath $fixtureConfig -Encoding UTF8
  $invalidArrayRejected = $false
  try { $null = Read-PluginEntries $fixtureConfig } catch { $invalidArrayRejected = $true }
  Assert-Predicate 'plugins scalar rejected' $invalidArrayRejected

  New-Item -ItemType Directory -Path (Join-Path $fixtureRepository 'src'), (Join-Path $installedPackage 'src') -Force | Out-Null
  'original' | Set-Content -LiteralPath (Join-Path $fixtureRepository 'src/sample.ts')
  'original' | Set-Content -LiteralPath (Join-Path $installedPackage 'src/sample.ts')
  git -C $fixtureRepository init --quiet | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'fixture git init failed' }
  git -C $fixtureRepository add -- src/sample.ts
  if ($LASTEXITCODE -ne 0) { throw 'fixture git add failed' }
  Assert-Predicate 'identical tracked tree accepted' (Test-TrackedTree $fixtureRepository $installedPackage 'src')
  'altered' | Set-Content -LiteralPath (Join-Path $installedPackage 'src/sample.ts')
  Assert-Predicate 'same-count modified content rejected' (-not (Test-TrackedTree $fixtureRepository $installedPackage 'src'))
  Remove-Item -LiteralPath (Join-Path $installedPackage 'src/sample.ts')
  Assert-Predicate 'missing tracked path rejected' (-not (Test-TrackedTree $fixtureRepository $installedPackage 'src'))
  New-Item -ItemType Directory -Path (Join-Path $fixtureRepository 'dist'), (Join-Path $installedPackage 'dist') -Force | Out-Null
  'business bundle' | Set-Content -LiteralPath (Join-Path $fixtureRepository 'dist/tui.js')
  'business bundle' | Set-Content -LiteralPath (Join-Path $installedPackage 'dist/tui.js')
  'export { default } from "./dist/tui.js"' | Set-Content -LiteralPath (Join-Path $fixtureRepository 'tui.js')
  'export { default } from "./dist/tui.js"' | Set-Content -LiteralPath (Join-Path $installedPackage 'tui.js')
  Assert-Predicate 'delivered TUI bundle and bridge match' (Test-DeliveredTuiFiles $fixtureRepository $installedPackage './dist/tui.js')
  'other bridge' | Set-Content -LiteralPath (Join-Path $installedPackage 'tui.js')
  Assert-Predicate 'changed installed root bridge rejected' (-not (Test-DeliveredTuiFiles $fixtureRepository $installedPackage './dist/tui.js'))
  'export { default } from "./dist/tui.js"' | Set-Content -LiteralPath (Join-Path $installedPackage 'tui.js')
  'other bundle' | Set-Content -LiteralPath (Join-Path $installedPackage 'dist/tui.js')
  Assert-Predicate 'changed installed TUI bundle rejected' (-not (Test-DeliveredTuiFiles $fixtureRepository $installedPackage './dist/tui.js'))
  Remove-Item -LiteralPath (Join-Path $installedPackage 'dist/tui.js')
  Assert-Predicate 'missing installed TUI bundle rejected' (-not (Test-DeliveredTuiFiles $fixtureRepository $installedPackage './dist/tui.js'))
} finally {
  Remove-Item -LiteralPath $fixtureRoot -Recurse -Force -ErrorAction SilentlyContinue
}
