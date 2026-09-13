# Isolated regression runner.
# NOTE: ASCII-only source on purpose - Windows PowerShell 5.1 reads BOM-less .ps1 as ANSI,
#       so non-ASCII comments/strings can break parsing.
# WHY this exists: the sandbox reclaims background processes after each tool call, so the
#       server under test must be started AND stopped inside the same call. Otherwise it
#       dies mid-run and produces mass false failures.
# Isolation: dedicated port 8091 + dedicated data dir (_smoke/_data).
param(
  [string]$Suites = 'run.js,predict-engine.js,predict-ui.js,real-ui.js,nav-groups.js,calendar.js,snapshot-sync.js,review-history.js,backtest-analysis.js,website-smoke.js,api-fields.js'
)
$ErrorActionPreference = 'Continue'
$suiteList = @($Suites -split ',' | ForEach-Object { $_.Trim() } | Where-Object { $_ })
$smoke = $PSScriptRoot
$root = Split-Path -Parent $smoke
$app = $root
$data = Join-Path $smoke '_data'
New-Item -ItemType Directory -Force $data | Out-Null

# Chinese literals built from code points to keep this file pure ASCII
$SUM = [string]([char]0x603B) + [char]0x8BA1 + ':'          # "zong ji :"
$FAILW = [string]([char]0x5931) + [char]0x8D25 + ':'        # "shi bai :"
$CRASH = [string]([char]0x5D29) + [char]0x6E83              # "beng kui"

$env:PORT = '8091'
$env:QP_DATA_DIR = $data
$srv = Start-Process -FilePath 'node' -ArgumentList 'server.js' -WorkingDirectory $app -PassThru -WindowStyle Hidden
try {
  $ready = $false
  foreach ($i in 1..40) {
    try { Invoke-WebRequest 'http://127.0.0.1:8091/api/ping' -UseBasicParsing -TimeoutSec 2 | Out-Null; $ready = $true; break }
    catch { Start-Sleep -Milliseconds 700 }
  }
  if (-not $ready) { Write-Output '[FATAL] isolated instance not ready on 8091'; exit 1 }
  Write-Output '[ENV] isolated instance ready: http://127.0.0.1:8091 (data dir _smoke/_data)'
  Write-Output ''

  $env:QP_TEST_BASE = 'http://127.0.0.1:8091'
  Set-Location $smoke
  $total = 0; $fails = 0
  foreach ($t in $suiteList) {
    $out = & node $t 2>&1
    $line = $out | Select-String -Pattern ([regex]::Escape($SUM))
    Write-Output "=== $t ==="
    if ($line) {
      Write-Output ('    ' + $line[0].ToString().Trim())
      if ($line[0].ToString() -match ($SUM + '\s*(\d+)\s*\S*\s*\S*\s*(\d+)')) {
        $total += [int]$Matches[1]; $fails += [int]$Matches[2]
      }
    } else {
      Write-Output '    (no summary line - possible crash)'
    }
    $out | Select-String -Pattern 'FAIL' | ForEach-Object { Write-Output ('    ' + $_.ToString().Trim()) }
    $out | Select-String -Pattern $CRASH | ForEach-Object { Write-Output ('    ' + $_.ToString().Trim()) }
  }
  Write-Output ''
  Write-Output "########## TOTAL: $total items, failed $fails ##########"
  if ($fails -gt 0) { exit 1 } else { exit 0 }
}
finally {
  if ($srv -and -not $srv.HasExited) { Stop-Process -Id $srv.Id -Force -ErrorAction SilentlyContinue }
}
