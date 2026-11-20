<#
.SYNOPSIS
    ChatGPT 时区修复扩展 —— 一键安装助手（Windows / PowerShell）

.DESCRIPTION
    1. 检查扩展目录是否已构建
    2. 打开 Chrome 的 chrome://extensions 页面
    3. 在资源管理器中定位到扩展目录
    4. 控制台打印后续 3 步操作指引

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File .\install.ps1
#>

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path

$candidates = @(
    (Join-Path $root 'dist\chatgpt-tz-fix'),
    (Join-Path $root 'extension')
)
$extDir = $candidates | Where-Object { Test-Path (Join-Path $_ 'manifest.json') } | Select-Object -First 1

Write-Host ''
Write-Host '  ============================================' -ForegroundColor Cyan
Write-Host '    ChatGPT 时区修复 · 安装助手' -ForegroundColor Cyan
Write-Host '  ============================================' -ForegroundColor Cyan
Write-Host ''

if (-not $extDir) {
    Write-Host '  [错误] 没有找到已构建的扩展目录。' -ForegroundColor Red
    Write-Host '        请先在本目录执行：node tools\build.cjs' -ForegroundColor Yellow
    exit 1
}

Write-Host ('  扩展目录：' + $extDir) -ForegroundColor Green
Write-Host ''
Write-Host '  接下来请按 3 步操作：'
Write-Host '    1. 在打开的页面右上角打开「开发者模式」'
Write-Host '    2. 点击「加载已解压的扩展程序」'
Write-Host '    3. 选择下面会自动弹出的文件夹'
Write-Host ''

$chromeCandidates = @(
    "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
    "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
    "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe"
)
$chrome = $chromeCandidates | Where-Object { Test-Path $_ } | Select-Object -First 1

if ($chrome) {
    Start-Process -FilePath $chrome -ArgumentList '--new-window', 'chrome://extensions/'
    Write-Host '  已打开 Chrome 扩展管理页。' -ForegroundColor Green
} else {
    Write-Host '  未检测到 Chrome，请手动打开 chrome://extensions/' -ForegroundColor Yellow
}

Start-Process explorer.exe $extDir
Write-Host '  已在资源管理器中定位扩展目录。' -ForegroundColor Green
Write-Host ''
Write-Host '  加载后扩展会自动打开 ChatGPT 并立即生效。' -ForegroundColor Cyan
