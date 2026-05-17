$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $root

function Wait-ForLocalGame {
  for ($i = 0; $i -lt 30; $i++) {
    try {
      Invoke-WebRequest -Uri "http://127.0.0.1:3000/api/state" -UseBasicParsing -TimeoutSec 1 | Out-Null
      return $true
    } catch {
      Start-Sleep -Milliseconds 500
    }
  }
  return $false
}

function Find-TunnelUrl {
  param([string[]]$LogPaths)

  $text = ""
  foreach ($path in $LogPaths) {
    if (Test-Path $path) {
      $text += "`n"
      $text += Get-Content $path -Raw -ErrorAction SilentlyContinue
    }
  }
  $match = [regex]::Match($text, "https://[-a-z0-9]+\.trycloudflare\.com")
  if ($match.Success) {
    return $match.Value
  }
  return $null
}

Write-Host ""
Write-Host "Starting Market Mayhem internet mode..."
Write-Host ""

if (!(Get-Command node -ErrorAction SilentlyContinue)) {
  Write-Host "Node.js is not installed or is not on PATH."
  Write-Host "Install Node.js LTS from https://nodejs.org/ and run this again."
  Pause
  exit 1
}

if (!(Get-Command cloudflared -ErrorAction SilentlyContinue)) {
  Write-Host "cloudflared is needed to make a public internet link."
  Write-Host ""
  Write-Host "Install option:"
  Write-Host "  winget install -e --id Cloudflare.cloudflared"
  Write-Host ""
  Write-Host "After it installs, close this window and run internet mode again."
  Write-Host "Official docs: https://developers.cloudflare.com/tunnel/"
  Write-Host ""
  $answer = Read-Host "Try installing cloudflared now with winget? Type Y and press Enter, or press Enter to skip"
  if ($answer -match "^[Yy]") {
    winget install -e --id Cloudflare.cloudflared
    Write-Host ""
    Write-Host "If the install finished, close this window and run internet mode again."
  }
  Pause
  exit 1
}

$serverOk = Wait-ForLocalGame
if (!$serverOk) {
  Write-Host "Starting local game server..."
  Start-Process -FilePath "cmd.exe" -ArgumentList "/k cd /d `"$root`" && node server.js" -WindowStyle Normal
  $serverOk = Wait-ForLocalGame
}

if (!$serverOk) {
  Write-Host ""
  Write-Host "The local game server did not start."
  Write-Host "Look at the Market Mayhem Server window for the error."
  Pause
  exit 1
}

$outLogPath = Join-Path $root "cloudflared-internet-out.log"
$errLogPath = Join-Path $root "cloudflared-internet-err.log"
Remove-Item -LiteralPath $outLogPath -ErrorAction SilentlyContinue
Remove-Item -LiteralPath $errLogPath -ErrorAction SilentlyContinue

Write-Host "Creating public internet link..."
Write-Host "Keep this window open while friends are playing."
Write-Host ""

$tunnel = Start-Process -FilePath "cloudflared" `
  -ArgumentList "tunnel --url http://127.0.0.1:3000" `
  -RedirectStandardOutput $outLogPath `
  -RedirectStandardError $errLogPath `
  -WindowStyle Hidden `
  -PassThru

$publicUrl = $null
for ($i = 0; $i -lt 60; $i++) {
  $publicUrl = Find-TunnelUrl -LogPaths @($outLogPath, $errLogPath)
  if ($publicUrl) {
    break
  }
  if ($tunnel.HasExited) {
    break
  }
  Start-Sleep -Seconds 1
}

if (!$publicUrl) {
  Write-Host "The tunnel did not produce a public link."
  Write-Host "Log:"
  if (Test-Path $outLogPath) {
    Get-Content $outLogPath
  }
  if (Test-Path $errLogPath) {
    Get-Content $errLogPath
  }
  Pause
  exit 1
}

$localHostUrl = "http://127.0.0.1:3000/host.html"
$publicHostUrl = "$publicUrl/host.html"
$playerUrl = "$publicUrl/player.html"
Set-Content -LiteralPath (Join-Path $root "INTERNET-JOIN-LINK.txt") -Value $playerUrl

Write-Host ""
Write-Host "HOST SCREEN ON THIS COMPUTER:"
Write-Host $localHostUrl
Write-Host ""
Write-Host "PUBLIC HOST BACKUP:"
Write-Host $publicHostUrl
Write-Host ""
Write-Host "SEND THIS TO FRIENDS:"
Write-Host $playerUrl
Write-Host ""
Write-Host "If this window closes, the internet link stops working."
Write-Host ""

Start-Process $localHostUrl

try {
  while (!$tunnel.HasExited) {
    Start-Sleep -Seconds 2
  }
} finally {
  if (!$tunnel.HasExited) {
    Stop-Process -Id $tunnel.Id -Force
  }
}
