param(
  [Parameter(Mandatory=$true)][string]$Server,
  [string]$User = 'root',
  [string]$Zip = '',
  [string]$RemoteDir = '',
  [string]$Pm2Name = 'quantpick',
  [switch]$NoCheck,
  [switch]$DryRun
)
# ============================================================================
# QuantPick remote update helper.
#
# ASCII-only source on purpose: Windows PowerShell 5.1 reads BOM-less .ps1 as ANSI,
# so non-ASCII comments/strings would break parsing. CRLF endings are required too -
# PS 5.1 cannot parse here-strings in LF-only files, which is why the remote script
# is assembled from an array of lines instead of a here-string.
#
# Steps (2 password prompts unless you set up ssh-copy-id):
#   1. upload the update zip to <User>@<Server>:/root/
#   2. discover the REAL app directory from pm2 (does not assume /opt/quantpick)
#   3. back up server.js, unzip over the app dir, restart pm2
#   4. run the in-app deploy self-check (deploy/check.js)
#
# Usage:
#   powershell -NoProfile -ExecutionPolicy Bypass -File deploy/push-update.ps1 -Server 1.2.3.4
#   ... -RemoteDir /www/wwwroot/example.com      # override app-dir detection
#   ... -Zip C:\path\to\quantpick-1.0.1-update.zip
#   ... -DryRun                                  # print the remote commands and exit
#   ... -NoCheck                                 # skip the remote self-check
#
# Tip: run `ssh-copy-id <User>@<Server>` once to switch to key auth, then updates
#      become non-interactive and scriptable.
# ============================================================================
$ErrorActionPreference = 'Continue'

$repo = Split-Path -Parent $PSScriptRoot          # ...\quantpick
$repoParent = Split-Path -Parent $repo

function Fail($msg) { Write-Host "[ERROR] $msg" -ForegroundColor Red; exit 1 }

# Remote script builder. Deliberately simple: no `set -e`, every critical step
# checks its own exit code, and a final REMOTE_UPDATE_OK token marks success.
function New-RemoteScript($AppDir, $Stamp, $Archive, $Name) {
  $lines = @(
    ("cd '{0}' || {{ echo CD_FAILED; exit 11; }}" -f $AppDir),
    ("if [ -f server.js ]; then cp server.js /root/server.js.bak-{0} && echo '[backup] /root/server.js.bak-{0}'; fi" -f $Stamp),
    "echo `"[before] server.js `$(md5sum server.js | cut -d' ' -f1) `$(stat -c%s server.js) bytes`"",
    ("unzip -o /root/{0} -d '{1}' > /dev/null || {{ echo UNZIP_FAILED; exit 13; }}" -f $Archive, $AppDir),
    "echo `"[after ] server.js `$(md5sum server.js | cut -d' ' -f1) `$(stat -c%s server.js) bytes`"",
    "grep -q 'fp !== ROOT' server.js || { echo '[FATAL] guard fix NOT found in deployed server.js'; exit 12; }",
    ("pm2 restart {0} > /dev/null || {{ echo PM2_RESTART_FAILED; exit 14; }}" -f $Name),
    "echo '[pm2] restarted'",
    "sleep 3",
    ("pm2 list | grep {0} || true" -f $Name),
    "echo REMOTE_UPDATE_OK"
  )
  return (($lines -join "`n") + "`n")
}

if (-not (Get-Command ssh -ErrorAction SilentlyContinue)) { Fail 'ssh not found in PATH' }
if (-not (Get-Command scp -ErrorAction SilentlyContinue)) { Fail 'scp not found in PATH' }

# ---------- 1. locate the update zip ----------
if (-not $Zip) {
  $cands = @()
  foreach ($dir in @($repoParent, $repo)) {
    if (Test-Path $dir) {
      $cands += Get-ChildItem -Path $dir -Filter 'quantpick-*-update.zip' -File -ErrorAction SilentlyContinue
      $cands += Get-ChildItem -Path $dir -Filter 'quantpick-update.zip' -File -ErrorAction SilentlyContinue
    }
  }
  $cands = $cands | Sort-Object LastWriteTime -Descending
  if (-not $cands) { Fail 'no update zip found; build one with: git archive --format=zip -o ..\quantpick-x.y.z-update.zip HEAD server.js index.html css js website deploy/check.js' }
  $Zip = $cands[0].FullName
}
if (-not (Test-Path $Zip)) { Fail "zip not found: $Zip" }
$zipItem = Get-Item $Zip
$zipName = $zipItem.Name
Write-Host ('[1/5] zip    : {0} ({1:N0} bytes, {2})' -f $zipName, $zipItem.Length, $zipItem.LastWriteTime)

$stamp = (Get-Date).ToString('yyyyMMdd-HHmmss')
$target = '{0}@{1}:/root/' -f $User, $Server

# ---------- dry run ----------
if ($DryRun) {
  $appDir = if ($RemoteDir) { $RemoteDir } else { '/opt/quantpick' }
  if (-not $RemoteDir) { Write-Host '(dry-run) -RemoteDir not given; the real value is auto-detected from pm2 (placeholder shown below)' -ForegroundColor Yellow }
  Write-Host ('[dry-run] target    : {0}   app dir: {1}   pm2: {2}' -f $target, $appDir, $Pm2Name)
  Write-Host ('[dry-run] would run : scp {0} -> {1}' -f $zipName, $target)
  Write-Host '[dry-run] remote script:'
  Write-Host '----------------------------------------'
  Write-Host (New-RemoteScript $appDir $stamp $zipName $Pm2Name).TrimEnd()
  Write-Host '----------------------------------------'
  if (-not $NoCheck) { Write-Host ("[dry-run] then      : cd '{0}' && node deploy/check.js" -f $appDir) }
  exit 0
}

# ---------- 2. upload ----------
Write-Host ('[2/5] upload : scp -> {0}   (password prompt #1)' -f $target)
& scp $Zip $target
if ($LASTEXITCODE -ne 0) { Fail "scp failed (exit $LASTEXITCODE)" }

# ---------- 3. discover the app dir ----------
Write-Host ('[3/5] detect : pm2 describe {0}   (password prompt #2)' -f $Pm2Name)
$detect = & ssh ('{0}@{1}' -f $User, $Server) ("pm2 describe {0} 2>/dev/null | grep -E 'script path|exec cwd|status' || echo PM2_NOT_FOUND" -f $Pm2Name)
$detectText = ($detect | Out-String)
Write-Host $detectText.Trim()
if ($detectText -match 'PM2_NOT_FOUND') { Fail ("pm2 process '{0}' not found on the server; check `pm2 list` and pass -Pm2Name <name>" -f $Pm2Name) }

$detected = ''
if ($detectText -match 'exec cwd\s*[|:]\s*(\S+)') { $detected = $Matches[1] }
if (-not $RemoteDir) {
  if (-not $detected) { Fail 'could not detect the app directory from pm2; pass -RemoteDir <path>' }
  $RemoteDir = $detected
  Write-Host ('      detected app dir: {0}' -f $RemoteDir)
} elseif ($detected -and $detected -ne $RemoteDir) {
  Write-Host ('      WARNING: pm2 reports cwd={0} but -RemoteDir={1} was passed; using the latter.' -f $detected, $RemoteDir) -ForegroundColor Yellow
}

# ---------- 4. remote update ----------
Write-Host '[4/5] update : backup + unzip + pm2 restart'
$remoteScript = New-RemoteScript $RemoteDir $stamp $zipName $Pm2Name
$out = $remoteScript | & ssh ('{0}@{1}' -f $User, $Server) 'bash -s'
$outText = ($out | Out-String)
Write-Host $outText.Trim()
$rc = $LASTEXITCODE
if ($rc -ne 0 -or $outText -notmatch 'REMOTE_UPDATE_OK') {
  Write-Host ''
  Write-Host '[ROLLBACK] if anything looks wrong, run on the server:' -ForegroundColor Yellow
  Write-Host ("  cp /root/server.js.bak-{0} {1}/server.js && pm2 restart {2}" -f $stamp, $RemoteDir, $Pm2Name) -ForegroundColor Yellow
  Fail "remote update failed (exit $rc)"
}

# ---------- 5. self-check ----------
if (-not $NoCheck) {
  Write-Host '[5/5] check  : deploy/check.js on the server'
  $chk = & ssh ('{0}@{1}' -f $User, $Server) ("cd '{0}' && node deploy/check.js" -f $RemoteDir)
  Write-Host ($chk | Out-String).Trim()
} else {
  Write-Host '[5/5] check  : skipped (-NoCheck)'
}

Write-Host ''
Write-Host 'DONE. Verify from outside with:' -ForegroundColor Green
Write-Host '  curl.exe -s -o NUL -w "server.js %{http_code}`n" https://<your-domain>/server.js'
Write-Host '  curl.exe -s -o NUL -w ".git      %{http_code}`n" https://<your-domain>/.git/config'
Write-Host '  curl.exe -s -o NUL -w "traversal %{http_code}`n" "https://<your-domain>/..%2f..%2fetc%2fpasswd"'
Write-Host 'Expect 403 / 403 (404 is also fine when the server has no .git) / 403.'
