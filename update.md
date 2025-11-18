下面这份当成项目的「设计 + 使用说明文档」来看就行，全部是 **Python 后端 + React 前端 + xterm.js**，重点解决：

* ✅ 多个终端会话（session）的管理
* ✅ 每个会话是 **多轮对话模式**（长寿命 CLI）
* ✅ 解决 `No input provided via stdin` / `stdout is not a terminal`
* ✅ 解决 xterm.js 删除、清屏、切换时丢信息的问题

---

## 1. 背景与目标

我们希望搭一个 **Web 端的多终端管理器**，在浏览器里像 VS Code 一样：

* 创建多个「终端会话」（每个会话底下是一个本地 CLI 程序，比如 `pwsh.exe`、`gemini chat` 等）。
* 每个会话支持 **多轮对话**：持续交互，而不是“一问一答立即退出”。
* 切换终端 tab 时，后台进程继续跑，输出不丢。
* 刷新页面 / 断线重连后，可以基于历史日志恢复现场。

技术栈限定为：

* **后端：Python（FastAPI + WebSocket + pywinpty）**
* **前端：React + xterm.js**

---

## 2. 整体架构概览

### 2.1 逻辑结构

```text
┌───────────────────────── 浏览器 ─────────────────────────┐
│                                                          │
│   React 应用                                             │
│   ┌───────────────────────────────────────────────────┐  │
│   │  TerminalManager：管理多个终端 tab                │  │
│   │   ├─ TerminalView(sessionId=A)：xterm 实例 + WS   │  │
│   │   ├─ TerminalView(sessionId=B)：xterm 实例 + WS   │  │
│   │   └─ ...                                          │  │
│   └───────────────────────────────────────────────────┘  │
│                                                          │
└──────────────────── WebSocket / HTTP ─────────────────────┘
                         ↓
┌───────────────────────── 后端（Python） ───────────────────┐
│ FastAPI + WebSocket                                       │
│                                                           │
│  SessionManager                                           │
│   ├─ session A                                            │
│   │   ├─ PTY 进程：pywinpty.PtyProcess + CLI (pwsh/gemini)│
│   │   ├─ websockets: [ws1, ws2...]                       │
│   │   └─ log_buffer / log_file                           │
│   ├─ session B                                            │
│   └─ ...                                                  │
└───────────────────────────────────────────────────────────┘
```

### 2.2 核心原则

1. **每个会话对应一个「长寿命 PTY 进程」**
   用 pywinpty 创建 PTY，让 CLI 认为自己在「真终端」中 → 解决 `stdout is not a terminal`。

2. **前端的 xterm.js 是“终端画面”，后端 PTY 是“真实终端”**
   输入：xterm 把按键原样通过 WebSocket 发给后端 → PTY → CLI。
   输出：PTY 输出的字节（包括 ANSI 颜色、清屏、删除）通过 WebSocket 原样传给 xterm。

3. **多轮对话 = 不杀进程 + 不关 WS**
   只要 Python 不终止 PTY 进程，会话就可以一直对话。

4. **多终端管理 = 前端多 xterm 实例 + 后端多 session + 不销毁只隐藏**
   切换 tab 时不要 dispose 终端 / 关闭 WS，只隐藏对应 DOM 即可。

5. **历史不丢 = 后端日志 + 前端 buffer + 重连时补发**

---

## 3. 后端设计（Python + FastAPI + pywinpty）

### 3.1 依赖与目录结构示意

#### 依赖

```bash
pip install fastapi uvicorn[standard] pywinpty
```

#### 目录结构建议

```text
backend/
  main.py              # FastAPI 入口
  sessions.py          # 会话管理、PTY 封装
  models.py            # 一些数据结构声明（可选）
  logs/                # 可选：每个 session 的日志文件
```

---

### 3.2 Session 模型（概念）

每个终端会话包含：

* `session_id: str`
* `pty_proc: pywinpty.PtyProcess`        # 真正的终端进程
* `websockets: set[WebSocket]`          # 当前连接到该 session 的所有前端连接
* `log_buffer: list[str]` 或 `log_file` # 保存历史输出，支持恢复

---

### 3.3 使用 pywinpty 启动 PTY 会话（解决 stdout 不是终端）

关键代码示意：

```python
# sessions.py
import pywinpty
import threading
import asyncio

class Session:
    def __init__(self, session_id: str, cmd: list[str]):
        self.id = session_id
        self.pty_proc = pywinpty.PtyProcess.spawn(cmd)
        self.websockets = set()
        self.log_buffer: list[str] = []
        self._start_reader_thread()

    def _start_reader_thread(self):
        loop = asyncio.get_running_loop()

        def _read_loop():
            try:
                while True:
                    data = self.pty_proc.read(1024)
                    if not data:
                        break
                    # 写入后端 buffer / 文件
                    self.log_buffer.append(data)

                    # 广播到所有前端
                    for ws in list(self.websockets):
                        asyncio.run_coroutine_threadsafe(ws.send_text(data), loop)
            except Exception:
                pass

        t = threading.Thread(target=_read_loop, daemon=True)
        t.start()

    def write(self, data: str):
        # 前端过来的按键或命令，原样写入 PTY
        self.pty_proc.write(data)

    def close(self):
        try:
            self.pty_proc.terminate(force=True)
        except Exception:
            pass
```

---

### 3.4 FastAPI WebSocket 接入（多轮对话）

```python
# main.py
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from sessions import Session
import uvicorn
import uuid

app = FastAPI()
sessions: dict[str, Session] = {}

def get_or_create_session(session_id: str) -> Session:
    if session_id not in sessions:
        # 这里你可以把命令改成 gemini 的交互模式，比如 ["gemini", "chat", ...]
        sessions[session_id] = Session(session_id, ["pwsh.exe"])
    return sessions[session_id]

@app.websocket("/ws/{session_id}")
async def terminal_ws(ws: WebSocket, session_id: str):
    await ws.accept()

    session = get_or_create_session(session_id)
    session.websockets.add(ws)

    try:
        while True:
            # 前端每个按键 / 文本都原样发过来
            data = await ws.receive_text()
            session.write(data)
    except WebSocketDisconnect:
        session.websockets.discard(ws)
    except Exception:
        session.websockets.discard(ws)

@app.get("/history/{session_id}")
def get_history(session_id: str):
    session = sessions.get(session_id)
    if not session:
        return {"content": ""}
    return {"content": "".join(session.log_buffer)}

@app.post("/sessions")
def create_session():
    sid = str(uuid.uuid4())
    get_or_create_session(sid)
    return {"session_id": sid}

if __name__ == "__main__":
    uvicorn.run(app, host="127.0.0.1", port=8000)
```

说明：

* `/ws/{session_id}`：一个会话对应一个长 WebSocket，用于多轮交互。
* `/history/{session_id}`：拉取已有的历史输出，支持刷新页面后恢复终端内容。
* `/sessions`：创建新会话。

---

## 4. 前端设计（React + xterm.js）

### 4.1 依赖与结构示意

```bash
npm install xterm
```

目录结构：

```text
frontend/
  src/
    components/
      TerminalManager.tsx  # 多终端 tab 管理
      TerminalView.tsx     # 单个终端视图（xterm + ws）
```

---

### 4.2 单个 TerminalView（多轮对话 + 删除清屏正常）

关键点：

* 用 `xterm.Terminal` 作为 UI。
* 用 `onData` 把**每一个按键**发给后端。
* 接收后端消息时，`term.write(data)`，保留颜色、光标移动、清屏等效果。

```tsx
// TerminalView.tsx
import React, { useEffect, useRef } from 'react';
import { Terminal } from 'xterm';
import 'xterm/css/xterm.css';

interface Props {
  sessionId: string;
  active: boolean;
}

export const TerminalView: React.FC<Props> = ({ sessionId, active }) => {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const wsRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    const term = new Terminal({
      cursorBlink: true,
      scrollback: 5000,
      fontFamily: 'monospace',
    });
    termRef.current = term;

    if (containerRef.current) {
      term.open(containerRef.current);
    }

    // 先拉历史内容恢复画面（可选）
    fetch(`/history/${sessionId}`)
      .then(res => res.json())
      .then(data => {
        if (data.content) {
          term.write(data.content);
        }
      });

    const ws = new WebSocket(`ws://localhost:8000/ws/${sessionId}`);
    wsRef.current = ws;

    ws.onmessage = (event) => {
      term.write(event.data);
    };

    // 将每个字符原样发给后端（解决 Backspace / Ctrl+L / 上下键等问题）
    term.onData((data) => {
      ws.send(data);
    });

    ws.onclose = () => {
      term.write('\r\n*** connection closed ***\r\n');
    };

    return () => {
      ws.close();
      term.dispose();
    };
  }, [sessionId]);

  return (
    <div
      ref={containerRef}
      style={{
        width: '100%',
        height: '100%',
        display: active ? 'block' : 'none',
      }}
    />
  );
};
```

---

### 4.3 TerminalManager：多终端 Tab 管理，切换不中断

核心思路：

* `sessions[]` 中保存所有 sessionId。
* 当前打开哪个 session → 用 `activeSessionId` 控制展示。
* 每一个 `TerminalView` 都挂在 DOM 中，只是用 `display: none` 隐藏非活动的。

```tsx
// TerminalManager.tsx
import React, { useEffect, useState } from 'react';
import { TerminalView } from './TerminalView';

interface SessionInfo {
  id: string;
}

export const TerminalManager: React.FC = () => {
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);

  const createSession = async () => {
    const res = await fetch('/sessions', { method: 'POST' });
    const data = await res.json();
    const newId = data.session_id as string;
    setSessions(prev => [...prev, { id: newId }]);
    setActiveId(newId);
  };

  useEffect(() => {
    // 初始创建一个 session（可选）
    createSession();
  }, []);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      {/* 顶部 tab */}
      <div style={{ display: 'flex', borderBottom: '1px solid #ccc' }}>
        {sessions.map(s => (
          <div
            key={s.id}
            onClick={() => setActiveId(s.id)}
            style={{
              padding: '6px 12px',
              cursor: 'pointer',
              borderBottom: activeId === s.id ? '2px solid #1890ff' : '2px solid transparent',
            }}
          >
            {s.id.slice(0, 6)}
          </div>
        ))}
        <button onClick={createSession} style={{ marginLeft: 'auto' }}>
          +
        </button>
      </div>

      {/* 底部终端区域 */}
      <div style={{ flex: 1, position: 'relative' }}>
        {sessions.map(s => (
          <TerminalView
            key={s.id}
            sessionId={s.id}
            active={activeId === s.id}
          />
        ))}
      </div>
    </div>
  );
};
```

这样就实现了：

* 多个终端会话并存；
* 切换 tab 不会断开 WebSocket、不销毁 xterm → 输出不会丢；
* 每个会话都是多轮对话模式。

---

## 5. 与 CLI / AI 工具对接（多轮对话模式）

### 5.1 为什么之前会出现 `No input provided via stdin`？

因为当时是：

* 用 `subprocess.Popen(..., stdin=PIPE, stdout=PIPE)` 启动 gemini；
* 没有在启动时就给 stdin 或 `--prompt`；
* 而 gemini 的默认行为是：“如果不是交互模式，就必须有 stdin 或 prompt，否则报错”。

现在换成 **PTY 模式** 后，如果你用的是类似 `["gemini", "chat"]` 这种交互命令：

* CLI 会认为自己是跑在终端里；
* 进入交互 REPL；
* 你每次在 Web Terminal 中输入一行，它都会当成一轮对话。

### 5.2 如果 CLI 本身不支持交互，就不要强行当“终端”

这种情况就需要：

* 走「一问一答」模式；
* 多轮对话由 Python 自己维护上下文；
* 每次前端发一轮消息 → 后端起一个子进程执行 CLI → 得到结果 → 返回前端。

这就是另一个架构了（非本说明文档重点）。

---

## 6. 常见问题与对应解决方案总结

### Q1：`stdout is not a terminal`

**原因：**

* 进程是通过 `subprocess.Popen(..., stdout=PIPE)` 等非 TTY 方式启动；
* CLI 检测 `stdout.isatty() == False` → 认为不是终端 → 拒绝进入交互模式或报错。

**解决：**

* 使用 `pywinpty.PtyProcess.spawn([...])` 创建 PTY；
* 进程认为自己在真终端环境中。

---

### Q2：`No input provided via stdin. Input can be provided by piping...`

**原因：**

* CLI 设计为“一次性工具”；
* 你没有给 stdin 数据，也没有使用 `--prompt` 等参数。

**解决：**

* 如果使用多轮交互终端：要启用 CLI 的交互模式命令（比如 `gemini chat`）；
* 如果是一次性 CLI：改用“一问一答”的模式，由后端维护上下文。

---

### Q3：xterm.js 无法删除/清屏

**原因：**

* 前端只在回车时发送整行命令，Backspace/Ctrl+L 等控制字符没发给后端；
* 后端不是 PTY，Shell 没有发出清屏/删除的 ANSI 控制序列。

**解决：**

* 前端：使用 `term.onData(data => ws.send(data))`，把所有按键原样发送；
* 后端：用 PTY（pywinpty）包裹 CLI，将控制字符写入 PTY；
* 让 Shell 自己处理 Backspace/Ctrl+L/clear/cls，xterm.js 只负责渲染。

---

### Q4：终端输出很多，最后感觉“折叠了一大段”

**原因：**

* 终端有 scrollback 限制，比如 xterm 的 `scrollback: 1000`；
* 超出的历史已被丢弃，看起来像“折叠”。

**解决：**

* 提高 `scrollback`；
* 更推荐：后端 `log_buffer` 或日志文件记录全部输出，支持 history 接口恢复。

---

## 7. 小结

你现在要的这个系统，本质上是：

> **“用 Python 在 Windows 上托管多个 PTY 终端，每个终端绑定一个长 WebSocket，会话可多轮交互；
> 前端用 React + xterm.js 管理多个终端 tab，在浏览器里复刻 VS Code 的终端体验。”**

关键技术点：

1. **pywinpty 构造 PTY** → 让 CLI 认为自己在“真终端里”，解决 `stdout is not a terminal`，支持交互 + 彩色输出 + 清屏。
2. **WebSocket + xterm.js** → 前端用 `onData` 原样转发键盘事件，保持删除/清屏等行为与本地终端一致。
3. **Session Manager + 日志缓存** → 多会话、多终端管理；切 tab 不丢输出，刷新也能恢复。

