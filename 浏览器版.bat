@echo off
chcp 65001 >nul
title KernelHub Studio (Browser UI)
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js not found in PATH. Please install Node.js 18+ first.
  echo.
  pause
  exit /b 1
)
echo Starting KernelHub Studio in your browser (same UI, same engine)...
node tools\launch.js --browser
echo.
pause
