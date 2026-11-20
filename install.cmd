@echo off
chcp 65001 >nul
setlocal
title ChatGPT 时区修复 - 安装

echo.
echo  ============================================
echo    ChatGPT 时区修复 · 一键安装
echo  ============================================
echo.

set "SRC=%~dp0dist\chatgpt-tz-fix"
if not exist "%SRC%\manifest.json" (
  if exist "%~dp0extension\manifest.json" (
    set "SRC=%~dp0extension"
  ) else (
    echo  [错误] 找不到扩展目录，请先运行: node tools\build.cjs
    echo.
    pause
    exit /b 1
  )
)

echo  扩展目录：
echo    %SRC%
echo.
echo  接下来会自动打开 Chrome 的扩展管理页，请按下面 3 步操作：
echo.
echo    1. 打开右上角的「开发者模式」开关
echo    2. 点击「加载已解压的扩展程序」
echo    3. 选择窗口里已定位到的这个目录
echo.
echo  加载完成后，扩展会自动打开 ChatGPT 页面并生效。
echo.

rem 优先从注册表取 Chrome 实际安装路径；取不到再尝试常见位置
set "CHROME="
for /f "tokens=2,*" %%A in ('reg query "HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\chrome.exe" /ve 2^>nul ^| find "REG_SZ"') do set "CHROME=%%B"
if not defined CHROME if exist "%ProgramFiles%\Google\Chrome\Application\chrome.exe" set "CHROME=%ProgramFiles%\Google\Chrome\Application\chrome.exe"
if not defined CHROME if exist "%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe" set "CHROME=%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe" 2>nul
if not defined CHROME if exist "%LOCALAPPDATA%\Google\Chrome\Application\chrome.exe" set "CHROME=%LOCALAPPDATA%\Google\Chrome\Application\chrome.exe"

if defined CHROME (
  start "" "%CHROME%" --new-window "chrome://extensions/"
  echo  已打开 Chrome 扩展管理页。
) else (
  echo  未找到 Chrome，请手动打开 chrome://extensions/
)

timeout /t 2 >nul
explorer.exe "%SRC%"

echo.
echo  提示：如果 Chrome 没有自动打开，请手动访问 chrome://extensions/
echo.
pause
endlocal
