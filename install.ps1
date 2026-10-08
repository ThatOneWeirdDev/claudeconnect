# ClaudeConnect: one-line install for Windows (PowerShell).
#
#   irm https://raw.githubusercontent.com/ThatOneWeirdDev/claudeconnect/main/install.ps1 | iex
#
# It checks for Node.js, downloads the launcher (ClaudeConnect.mjs) and runs it. The launcher then downloads the current
# release, checks every file against the release manifest and runs setup.
# CLAUDECONNECT_REPO and CLAUDECONNECT_REF pick another source (a fork, a tag or a commit).
$ErrorActionPreference = "Stop"

$repo = if ($env:CLAUDECONNECT_REPO) { $env:CLAUDECONNECT_REPO } else { "ThatOneWeirdDev/claudeconnect" }
$ref  = if ($env:CLAUDECONNECT_REF)  { $env:CLAUDECONNECT_REF }  else { "main" }
$raw  = if ($env:CLAUDECONNECT_RAW)  { $env:CLAUDECONNECT_RAW }  else { "https://raw.githubusercontent.com" }

$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
  Write-Host "ClaudeConnect needs Node.js 22 or newer, and it isn't installed."
  Write-Host "Install the current LTS from https://nodejs.org, then run this again."
  return
}
$major = [int](& node -p "process.versions.node.split('.')[0]")
if ($major -lt 22) {
  Write-Host "ClaudeConnect needs Node.js 22 or newer, and you have $(& node --version)."
  Write-Host "Install the current LTS from https://nodejs.org, then run this again."
  return
}

$dir = Join-Path ([System.IO.Path]::GetTempPath()) ("claudeconnect-" + [System.Guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Path $dir | Out-Null
try {
  $file = Join-Path $dir "ClaudeConnect.mjs"
  Invoke-WebRequest -UseBasicParsing -Uri "$raw/$repo/$ref/ClaudeConnect.mjs" -OutFile $file
  & node $file @args
} finally {
  Remove-Item -Recurse -Force $dir -ErrorAction SilentlyContinue
}
