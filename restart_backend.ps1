# 停止所有占用8000端口的进程
Write-Host "正在查找占用8000端口的进程..." -ForegroundColor Yellow

$connections = netstat -ano | findstr :8000 | findstr LISTENING
$pids = @()

foreach ($line in $connections) {
    if ($line -match '\s+(\d+)\s*$') {
        $pid = $matches[1]
        if ($pid -notin $pids) {
            $pids += $pid
        }
    }
}

if ($pids.Count -eq 0) {
    Write-Host "没有找到占用8000端口的进程" -ForegroundColor Green
} else {
    Write-Host "找到 $($pids.Count) 个进程占用8000端口: $($pids -join ', ')" -ForegroundColor Cyan
    
    foreach ($pid in $pids) {
        try {
            $process = Get-Process -Id $pid -ErrorAction Stop
            Write-Host "停止进程 $pid ($($process.ProcessName))..." -ForegroundColor Yellow
            Stop-Process -Id $pid -Force
            Write-Host "进程 $pid 已停止" -ForegroundColor Green
        } catch {
            Write-Host "无法停止进程 $pid : $_" -ForegroundColor Red
        }
    }
}

# 等待端口释放
Write-Host "等待端口释放..." -ForegroundColor Yellow
Start-Sleep -Seconds 2

# 激活conda环境并启动后端
Write-Host "启动后端服务..." -ForegroundColor Cyan
Set-Location -Path "$PSScriptRoot\backend"

# 使用conda运行
$env:PYTHONIOENCODING = "utf-8"
conda activate terminal_manage
poetry run uvicorn app.main:app --host 127.0.0.1 --port 8000 --reload
