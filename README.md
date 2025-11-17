# Codex Terminal Manage

基于 FastAPI + React + Ant Design 的浏览器终端 MVP。后端通过 Poetry 管理依赖，前端采用 Vite 构建，满足 AGENTS.md 的全部要求：

- Python 服务：FastAPI + SQLite，使用 Poetry 维护依赖；
- 请先执行 `conda activate terminal_manage`，再进入 `backend` 目录进行安装、测试；
- Web 端：React + Ant Design + xterm.js，支持中文输出、命令回放、Git 状态查看；
- Session Profile 信息持久化在 SQLite，日志以 UTF-8/ANSI 字节写入 `backend/logs/<session_id>/raw.log`。

## 目录结构

```
backend/   # FastAPI 服务 + Poetry 工程
frontend/  # React + Vite + Ant Design 前端
```

## 后端运行步骤

```bash
conda activate terminal_manage
cd backend
poetry install
poetry run uvicorn app.main:app --reload --port 8000
```

> 默认会在 `backend/data/terminal_manage.db` 创建 SQLite 数据库，并生成一条“默认 PowerShell”配置。日志存放在 `backend/logs`。

### 常用环境变量

| 名称 | 说明 | 默认值 |
| ---- | ---- | ---- |
| `TERMINAL_MANAGE_DATABASE_URL` | 自定义数据库连接串 | `sqlite:///backend/data/terminal_manage.db` |
| `TERMINAL_MANAGE_DEFAULT_PROFILE_COMMAND` | 默认 shell | Windows: `pwsh` / 其他: `bash` |
| `TERMINAL_MANAGE_DEFAULT_CWD` | 进程默认工作目录 | 仓库根目录 |

## 前端运行步骤

```bash
cd frontend
npm install
npm run dev
```

默认前端会请求 `http://localhost:8000`，如需自定义后端地址，可以创建 `.env` 并设置：

```
VITE_API_BASE=http://127.0.0.1:8000
```

构建生产版本：

```bash
npm run build
npm run preview
```

## 功能概览

1. **Session Profile 管理**：新增/删除配置，支持命令、参数、工作目录及环境变量；
2. **终端会话**：通过 WebSocket 与 FastAPI 保持实时交互，xterm.js 显示 ANSI 彩色输出，输入命令后自动执行 Git 前后状态对比；
3. **日志系统**：后端将原始字节写入 `raw.log`，前端可查看全文日志；
4. **Git 状态 & Diff**：提供 REST API `GET /git_changes/{session_id}`，并在终端中以文本形式输出命令执行前后的差异；
5. **中文体验**：全链路使用 UTF-8，前端字体覆盖「思源黑体 / 微软雅黑」等字体，避免中文乱码。

## 后续可拓展

- Session 列表与历史回放；
- 多用户/鉴权；
- 上传命令脚本与批量执行；
- 更细粒度的 Git 变更展示（文件 diff 预览）。
