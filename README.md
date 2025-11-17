# Codex Terminal Manage

基于 FastAPI + React 构建的多终端管理工具。后端通过 Poetry 管理依赖，前端采用 Vite，满足 AGENTS.md 中“Python + React + Ant Design + UTF-8 + 美观 UI”的要求，并专门针对多终端调度做了扩展：

- 后端：FastAPI + SQLite + WebSocket，`conda activate terminal_manage && cd backend` 后使用 Poetry 安装/运行；
- 前端：React + Ant Design + xterm.js，所有页面元素使用中英双语友好字体；
- Session Profile、终端会话、运行状态等全部落盘至 SQLite（`backend/data/terminal_manage.db`），日志以 UTF-8/ANSI 写入 `backend/logs/<session_id>/raw.log`，即便重启也可回放；
- “设定”抽屉集中管理所有会话配置，主界面支持一次创建多个会话并快速切换终端视图。

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

1. **统一设定与配置模板**  
   右上角“设定”抽屉集中展示/增删 Session Profile（命令、参数、工作目录、环境变量），支持 UTF-8 输入。

2. **多终端批量创建与标签管理**  
   主界面可按配置一键创建 1~10 个终端，左侧列表永久保存所有历史记录（状态：运行中/完成/停止/错误/中断），并会在状态变化时弹出成功提示。

3. **终端实时交互 & 历史回放**  
   xterm.js 面板用于运行中会话；历史会话自动切换成“只读回放”模式，同时在终端顶部提示“以下内容来自历史日志”以区分上次运行的残留。

4. **日志与 Git 一键刷新 + 清理**  
   `GET /logs/{session}` 接口新增 `historical` 字段，前端按钮可随时手动刷新日志/Git 状态；后台 `POST /sessions` 支持 `quantity` 批量创建，同时提供 `DELETE /sessions/{id}` 清理会话并删除对应日志文件。左侧“历史会话”列表只在用户点击“刷新”或删除后更新，避免自动刷新打断终端。

5. **持久化与安全**  
   所有信息都写入 SQLite。应用重启后，会自动把上次遗留的“running”会话标记为 `interrupted`，告知用户这些 log 来自上一次运行；日志文件仍然保留原始 ANSI 内容。

## 后续可拓展

- 增加会话终止/重启 API；
- 接入用户鉴权与操作审计；
- 更细粒度的 Git Diff（逐文件展开）；
- 将会话列表与终端面板做窗口化布局，实现拖拽编排。
