@echo off
setlocal
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo Market Mayhem needs Node.js installed normally on this computer.
  echo.
  echo Install Node.js LTS from https://nodejs.org/
  echo Then close this window and double-click start-game.bat again.
  echo.
  pause
  exit /b 1
)

echo Starting Market Mayhem...
echo Keep the server window open while you play.

start "Market Mayhem Server" cmd /k "cd /d ""%~dp0"" && node server.js"

echo Waiting for the game server to wake up...
powershell -NoProfile -ExecutionPolicy Bypass -Command "$ok=$false; for($i=0; $i -lt 20; $i++){ try { Invoke-WebRequest -Uri 'http://127.0.0.1:3000/api/state' -UseBasicParsing -TimeoutSec 1 | Out-Null; $ok=$true; break } catch { Start-Sleep -Milliseconds 500 } }; if($ok){ exit 0 } else { exit 1 }"

if errorlevel 1 (
  echo.
  echo The game server did not start.
  echo Look at the separate "Market Mayhem Server" black window for the error message.
  echo Send Codex a screenshot of that server window.
  pause
  exit /b 1
)

start "" "http://127.0.0.1:3000/host.html"

echo.
echo The host screen should be open in your browser.
echo Put the join link shown there into phones on the same Wi-Fi.
pause
