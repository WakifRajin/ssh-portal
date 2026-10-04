@echo off
rem SSH Portal bridge launcher for Windows.
rem For X11 (ssh -Y) windows, start VcXsrv/X410 first. DISPLAY defaults to localhost:0.0.
cd /d "%~dp0"
where node >nul 2>nul || (echo Node.js 18+ is required: https://nodejs.org/ & pause & exit /b 1)
if not exist node_modules (
  echo Installing dependencies...
  call npm install --no-audit --no-fund || (pause & exit /b 1)
)
node server.js %*
pause
