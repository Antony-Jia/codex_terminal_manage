# ⭐ Web Terminal MVP 功能规划（更新版）

## 1. 产品目标

基于浏览器的轻量终端控制台，支持：

* 执行本地 Shell / PowerShell / AI CLI
* 中文 / ANSI 彩色输出
* 自动日志记录 & 回放
* Git 修改文件列表
* **命令执行前后 Git 状态对比**
* **每个 session 可指定启动命令行与环境变量，配置持久化在 SQLite**

---

## 2. MVP 核心功能清单

### 2.1 终端会话（Session）

* 每次创建一个 session（UUID）
* 从 SQLite 中读取对应的「启动配置」（命令行 + 环境变量 + 工作目录）
* 启动指定命令行进程（例如：`pwsh` / `bash` / `python my_cli.py`）
* 实时命令输入 / 输出
* 前端使用 xterm.js，支持中文 + ANSI 彩色

> 若未指定配置，则使用默认配置（如：`pwsh` + 当前项目目录 + 默认 env）。

---

### 2.2 Session 启动配置（SQLite）

**新增功能：每个 session 关联一个“启动配置”**

#### 2.2.1 功能点

* 定义“配置模板”（Session Profile），保存在 SQLite 中：

  * 可预先配置多种环境，例如：

    * 「默认 PowerShell」
    * 「codex 环境」
    * 「项目 A 的 venv + Python CLI」
* 创建 session 时：

  * 前端选择一个 profile（或使用默认 profile）
  * 后端从 SQLite 读取对应配置：

    * 启动命令行（命令 + 参数）
    * 工作目录（cwd）
    * 环境变量（env）
  * 按该配置启动子进程

#### 2.2.2 SQLite 表结构（建议）

**表：`session_profiles`**

| 字段         | 类型         | 说明                         |
| ---------- | ---------- | -------------------------- |
| id         | INTEGER PK | Profile 主键                 |
| name       | TEXT       | 配置名称（例如“默认 PowerShell”）    |
| command    | TEXT       | 启动命令（例如 `pwsh` / `python`） |
| args       | TEXT       | 启动参数（JSON 字符串数组）           |
| cwd        | TEXT       | 工作目录（可为空，空则用默认根目录）         |
| env_json   | TEXT       | 环境变量（JSON 字典）              |
| created_at | TEXT       | 创建时间                       |
| updated_at | TEXT       | 更新时间                       |

**表：`sessions`（运行时记录，可选）**

| 字段         | 类型      | 说明                       |
| ---------- | ------- | ------------------------ |
| id         | TEXT PK | session_id（UUID）         |
| profile_id | INTEGER | 使用的 profile id           |
| cwd        | TEXT    | 实际工作目录（可能等于 profile.cwd） |
| log_path   | TEXT    | raw.log 路径               |
| created_at | TEXT    | 创建时间                     |

> MVP 阶段：`session_profiles` 必须有，`sessions` 可选（方便后续统计/审计）。

#### 2.2.3 后端逻辑（简要流程）

1. 前端创建 session 时传 `profile_id`
2. 后端：

   * 从 SQLite 查询该 profile
   * 拼出启动命令：`[command] + json.loads(args)`
   * 设置 `cwd`：profile.cwd 或默认目录
   * 生成 env：`os.environ.copy() + json.loads(env_json)`
   * `asyncio.create_subprocess_exec(*cmd, cwd=cwd, env=env, stdin=PIPE, stdout=PIPE ...)`
3. 把该 session 的 `profile_id` / `cwd` / `log_path` 等写入内存字典（必要时写 sessions 表）

---

### 2.3 日志系统（Log）

* 每条输出（子进程 stdout/stderr）：

  * 通过 WebSocket 发给前端
  * 同时以 **原始字节形式** 写入 `raw.log`（UTF-8 + ANSI）
* 提供 `GET /logs/{session}`：

  * 返回完整日志文本（UTF-8 解码）
  * 前端调用 `term.write(logText)` 实现回放

---

### 2.4 Git 状态查看（Git Status）

* 如果 session 的 `cwd` 下存在 `.git`：

  * `git status --short` → 返回文件改动列表
  * `git diff --stat` → 返回改动统计信息
* 提供 REST 接口：

  * `GET /git_changes/{session}` → JSON

> 若不是 Git 仓库，返回 `{ git: false, message: "not a git repository" }`。

---

### 2.5 命令执行前后 Git 差异对比（Git Diff Before/After）

对每一条 **用户输入命令**（通过 WebSocket 发送）：

1. 若 `cwd` 是 Git 仓库：

   * 执行命令前：获取 `git status --short` → `before`
2. 写入命令到子进程 stdin
3. 简单等待命令输出（可以 sleep 200ms 或基于输出事件）
4. 再获取 `git status --short` → `after`
5. 在后端对 `before` 和 `after` 做差分，生成 `delta`：

   * 新增、删除、状态变化（如 `??` → `A` 或 `M`）
6. 以文本形式输出到终端，示例：

```text
=== Git Diff Before/After ===
Added:
  b.txt

Modified:
  src/main.py

Deleted:
  old/config.yaml
==============================
```

> 这一块仍然通过 WebSocket把结果写入终端，不强制做单独 API。

---

## 3. 通信 & 架构简图

### 3.1 通信方式

* **WebSocket**

  * 终端实时输入/输出
  * Git Diff 前后结果也可通过终端输出

* **REST API**

  * `GET /logs/{session}`：获取日志文本
  * `GET /git_changes/{session}`：获取 Git 状态
  * `GET /profiles` / `POST /profiles`（简单增删改查，可选）：

    * 管理 session_profiles（启动配置）

### 3.2 架构

```text
前端 (xterm.js + Profile 选择)
          │ WebSocket（命令 & 输出）
          ▼
FastAPI 后端
  - Session Manager
  - SQLite (session_profiles, sessions)
  - Shell 子进程启动 (使用 profile 的 command/cwd/env)
  - UTF-8 解码 & ANSI 透传
  - 日志写入 raw.log
  - Git status & diff-before/after
          │
          ▼
Shell 进程 (自定义命令行: pwsh / bash / CLI 等)
```

---

## 4. MVP 开发重点

1. **SQLite 配置驱动的 Session 启动**

   * profile 结构设计 & CRUD
   * 从数据库读取配置 → 实际构造 `create_subprocess_exec` 参数

2. **UTF-8 + ANSI 不丢失**

   * 子进程输出 bytes → UTF-8 decode 到前端
   * 原始 bytes 写入日志

3. **Git 对比逻辑**

   * 命令执行前后的 `git status --short` 解析为结构
   * 做简单 diff → 文本描述输出到终端

4. **前端 Profile 选择**

   * 创建 session 前列出 `session_profiles`
   * 选择后将 `profile_id` 携带到 WebSocket 连接（或通过 REST 创建 session 再返回 session_id）

---

## 5. MVP 验收标准

1. 能在浏览器里选择一个 profile（不同的启动命令/环境）创建 session。
2. 终端可以正常执行命令，支持中文输出和 ANSI 彩色。
3. 每次输出会写入 raw.log，通过“回放日志”可以重演彩色历史。
4. 在 Git 仓库目录配置 profile 并启动 session：

   * 执行命令前后能看到文件变更差异（添加/修改/删除）。
5. 所有配置（命令行、cwd、环境变量）重启服务后仍然保留（来自 SQLite）。

---
