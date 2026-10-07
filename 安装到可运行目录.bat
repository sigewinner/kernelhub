@echo off
chcp 65001 >nul
title KernelHub Studio - Install to a runnable folder
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js not found in PATH. Please install Node.js 18+ first.
  echo.
  pause
  exit /b 1
)
if not exist "release\win-unpacked" (
  echo [1/2] No build found. Building now ^(takes a few minutes^)...
  node tools\build.js --dir
  if errorlevel 1 goto :fail
)
echo [2/2] Installing to a runnable folder and launching...
node tools\install-local.js %*
echo.
pause
exit /b 0
:fail
echo.
echo Build failed. See the messages above.
pause
exit /b 1
