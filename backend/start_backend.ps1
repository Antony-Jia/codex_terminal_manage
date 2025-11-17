# 设置编码
$env:PYTHONIOENCODING = "utf-8"

# 激活conda环境并启动服务
& conda activate terminal_manage
poetry run uvicorn app.main:app --host 127.0.0.1 --port 8000 --reload
