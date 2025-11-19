# 简单暴力的重启脚本
$ErrorActionPreference = "SilentlyContinue"

Write-Host "正在停止占用 8000 端口的进程..." -ForegroundColor Yellow
$tcp = Get-NetTCPConnection -LocalPort 8000 -ErrorAction SilentlyContinue
if ($tcp) {
    foreach ($conn in $tcp) {
        try {
            $proc = Get-Process -Id $conn.OwningProcess -ErrorAction SilentlyContinue
            if ($proc) {
                Write-Host "停止进程: $($proc.Id) ($($proc.ProcessName))" -ForegroundColor Cyan
                Stop-Process -Id $proc.Id -Force
            }
        } catch {
            Write-Host "无法停止进程: $_" -ForegroundColor Red
        }
    }
} else {
    Write-Host "端口 8000 未被占用" -ForegroundColor Green
}

Start-Sleep -Seconds 2

Write-Host "正在启动后端..." -ForegroundColor Yellow
Set-Location "$PSScriptRoot\backend"

# 尝试加载 Conda
$conda_hook = "$env:USERPROFILE\anaconda3\shell\condabin\conda-hook.ps1"
if (-not (Test-Path $conda_hook)) {
    $conda_hook = "$env:USERPROFILE\miniconda3\shell\condabin\conda-hook.ps1"
}

if (Test-Path $conda_hook) {
    & $conda_hook
    conda activate terminal_manage
} else {
    Write-Host "未找到 Conda，尝试直接运行..." -ForegroundColor Yellow
}

$env:PYTHONIOENCODING = "utf-8"
poetry run uvicorn app.main:app --host 127.0.0.1 --port 8000 --reload
