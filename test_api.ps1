# 测试后端API
Write-Host "测试后端健康检查..." -ForegroundColor Cyan
try {
    $health = Invoke-WebRequest -Uri "http://127.0.0.1:8000/health" -UseBasicParsing
    Write-Host "✓ 健康检查成功: $($health.StatusCode)" -ForegroundColor Green
    Write-Host "  响应: $($health.Content)" -ForegroundColor Gray
} catch {
    Write-Host "✗ 健康检查失败: $_" -ForegroundColor Red
}

Write-Host "`n测试获取配置列表..." -ForegroundColor Cyan
try {
    $profiles = Invoke-WebRequest -Uri "http://127.0.0.1:8000/profiles" -UseBasicParsing
    Write-Host "✓ 获取配置成功: $($profiles.StatusCode)" -ForegroundColor Green
    Write-Host "  响应长度: $($profiles.Content.Length) 字节" -ForegroundColor Gray
    $data = $profiles.Content | ConvertFrom-Json
    Write-Host "  配置数量: $($data.Count)" -ForegroundColor Gray
} catch {
    Write-Host "✗ 获取配置失败: $_" -ForegroundColor Red
}

Write-Host "`n测试CORS预检请求..." -ForegroundColor Cyan
try {
    $headers = @{
        "Origin" = "http://127.0.0.1:5173"
        "Access-Control-Request-Method" = "GET"
        "Access-Control-Request-Headers" = "content-type"
    }
    $options = Invoke-WebRequest -Uri "http://127.0.0.1:8000/profiles" -Method OPTIONS -Headers $headers -UseBasicParsing
    Write-Host "✓ CORS预检成功: $($options.StatusCode)" -ForegroundColor Green
    Write-Host "  CORS Headers:" -ForegroundColor Gray
    $options.Headers.GetEnumerator() | Where-Object { $_.Key -like "Access-Control-*" } | ForEach-Object {
        Write-Host "    $($_.Key): $($_.Value)" -ForegroundColor Gray
    }
} catch {
    Write-Host "✗ CORS预检失败: $_" -ForegroundColor Red
}
