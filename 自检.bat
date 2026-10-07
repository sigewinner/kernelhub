@echo off
chcp 65001 >nul
title KernelHub Studio - Self Check
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js not found in PATH. Please install Node.js 18+ first.
  echo.
  pause
  exit /b 1
)
echo === Environment diagnostics ===
node tools\launch.js --diag
echo.
echo === Source audit (encoding / syntax / dependency boundary) ===
node tools\audit.js
echo.
echo === Engine end-to-end smoke test (real conversions) ===
node tools\smoke.js
echo.
pause
