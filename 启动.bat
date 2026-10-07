@echo off
chcp 65001 >nul
title KernelHub Studio
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js not found in PATH. Please install Node.js 18+ first.
  echo         https://nodejs.org/
  echo.
  pause
  exit /b 1
)
node tools\launch.js %*
set EXITCODE=%ERRORLEVEL%
if not "%EXITCODE%"=="0" (
  echo.
  echo [launcher exited with code %EXITCODE%]
  pause
)
