import { message } from "antd";
import { useCallback, useEffect, useRef, useState } from "react";
import { Terminal, type IDisposable } from "xterm";
import { FitAddon } from "xterm-addon-fit";
import { api, websocketUrl } from "../api";

export type TerminalStatus = "idle" | "connecting" | "connected" | "closed" | "error";
export type TerminalMode = "idle" | "live" | "replay";

interface TerminalPanelProps {
  sessionId?: string;
  sessionIds?: string[];
  mode?: TerminalMode;
  logContent?: string;
  note?: string;
  onStatusChange?: (status: TerminalStatus) => void;
}

interface LiveTerminalProps {
  sessionId?: string;
  sessionIds?: string[];
  note?: string;
  onStatusChange?: (status: TerminalStatus) => void;
}

interface ReplayTerminalProps {
  logContent?: string;
  note?: string;
}

interface SessionRuntime {
  id: string;
  term: Terminal;
  fitAddon: FitAddon;
  socket: WebSocket | null;
  disposables: IDisposable[];
  observer?: ResizeObserver;
  attached: boolean;
  container: HTMLDivElement | null;
  status: TerminalStatus;
}

const safeWrite = (term: Terminal, text: string, callback?: () => void) => {
  if (!text) {
    if (callback) {
      callback();
    }
    return;
  }
  try {
    if (callback) {
      term.write(text, callback);
    } else {
      term.write(text);
    }
  } catch (error) {
    console.warn("terminal write skipped", error);
    if (callback) {
      callback();
    }
  }
};

const createRuntime = (id: string): SessionRuntime => {
  const term = new Terminal({
    cursorBlink: true,
    fontSize: 14,
    scrollback: 5000,
    fontFamily: '"Cascadia Code", "Fira Code", monospace',
    convertEol: false,
    scrollOnUserInput: true,
    theme: {
      background: "#0f172a",
      foreground: "#f8fafc",
      black: "#1e293b",
      green: "#22c55e",
      blue: "#38bdf8",
    },
  });
  const fitAddon = new FitAddon();
  term.loadAddon(fitAddon);
  return {
    id,
    term,
    fitAddon,
    socket: null,
    disposables: [],
    observer: undefined,
    attached: false,
    container: null,
    status: "idle",
  };
};

const TerminalPanel = ({
  sessionId,
  sessionIds = [],
  mode = "idle",
  logContent,
  note,
  onStatusChange,
}: TerminalPanelProps) => {
  useEffect(() => {
    if (!onStatusChange) {
      return;
    }
    if (mode === "replay") {
      onStatusChange("closed");
    } else if (mode !== "live") {
      onStatusChange("idle");
    }
  }, [mode, onStatusChange]);

  if (mode === "replay") {
    return <ReplayTerminal logContent={logContent} note={note} />;
  }
  return (
    <LiveTerminalManager sessionId={sessionId} sessionIds={sessionIds} note={note} onStatusChange={onStatusChange} />
  );
};

const LiveTerminalManager = ({ sessionId, sessionIds = [], note, onStatusChange }: LiveTerminalProps) => {
  const runtimesRef = useRef<Map<string, SessionRuntime>>(new Map());
  const [mountedSessions, setMountedSessions] = useState<string[]>([]);
  const activeIdRef = useRef<string | undefined>(sessionId);
  const statusCallbackRef = useRef(onStatusChange);

  useEffect(() => {
    activeIdRef.current = sessionId;
  }, [sessionId]);

  useEffect(() => {
    statusCallbackRef.current = onStatusChange;
  }, [onStatusChange]);

  const updateStatus = useCallback((id: string, status: TerminalStatus) => {
    const runtime = runtimesRef.current.get(id);
    if (!runtime) {
      return;
    }
    runtime.status = status;
    if (activeIdRef.current === id) {
      statusCallbackRef.current?.(status);
    }
  }, []);

  const handleIncoming = useCallback((runtime: SessionRuntime, raw: MessageEvent["data"]) => {
    const applyText = (text?: string) => {
      if (!text) {
        return;
      }
      safeWrite(runtime.term, text, () => {
        // 自动滚动到底部,防止输入内容上移
        requestAnimationFrame(() => {
          try {
            runtime.term.scrollToBottom();
          } catch (error) {
            console.warn("scroll to bottom skipped", error);
          }
        });
      });
    };
    if (typeof raw === "string") {
      try {
        const payload = JSON.parse(raw);
        if (payload?.type === "output") {
          applyText(payload.data);
          return;
        }
      } catch {
        // fall through to raw text write
      }
      applyText(raw);
      return;
    }
    if (raw instanceof Blob) {
      void raw.text().then((text) => applyText(text));
      return;
    }
    if (raw instanceof ArrayBuffer) {
      applyText(new TextDecoder().decode(raw));
    }
  }, []);

  const connectRuntime = useCallback(
    (runtime: SessionRuntime) => {
      if (runtime.socket && runtime.socket.readyState !== WebSocket.CLOSED && runtime.socket.readyState !== WebSocket.CLOSING) {
        return;
      }
      const socket = new WebSocket(websocketUrl(runtime.id));
      runtime.socket = socket;
      updateStatus(runtime.id, "connecting");
      socket.onopen = () => {
        updateStatus(runtime.id, "connected");
      };
      socket.onmessage = (event) => handleIncoming(runtime, event.data);
      socket.onclose = () => {
        runtime.socket = null;
        updateStatus(runtime.id, "closed");
      };
      socket.onerror = () => {
        runtime.socket = null;
        message.error("终端连接异常");
        updateStatus(runtime.id, "error");
      };
      if (runtime.disposables.length === 0) {
        const disposable = runtime.term.onData((data) => {
          if (runtime.socket?.readyState === WebSocket.OPEN) {
            runtime.socket.send(data);
            // 立即滚动到底部，保持输入在可视区域
            try {
              runtime.term.scrollToBottom();
            } catch (error) {
              console.warn("scroll to bottom skipped", error);
            }
          }
        });
        runtime.disposables.push(disposable);
      }
    },
    [handleIncoming, updateStatus],
  );

  const ensureRuntime = useCallback((id: string) => {
    let runtime = runtimesRef.current.get(id);
    if (!runtime) {
      runtime = createRuntime(id);
      runtimesRef.current.set(id, runtime);
      setMountedSessions((prev) => (prev.includes(id) ? prev : [...prev, id]));
    }
    return runtime;
  }, []);

  const disposeRuntime = useCallback((id: string) => {
    const runtime = runtimesRef.current.get(id);
    if (!runtime) {
      return;
    }
    runtime.socket?.close();
    runtime.disposables.forEach((item) => item.dispose());
    runtime.observer?.disconnect();
    runtime.term.dispose();
    runtimesRef.current.delete(id);
  }, []);

  const attachContainer = useCallback((id: string, node: HTMLDivElement | null) => {
    const runtime = runtimesRef.current.get(id);
    if (!runtime) {
      return;
    }
    runtime.container = node;
    runtime.observer?.disconnect();
    runtime.observer = undefined;
    if (!node) {
      return;
    }
    if (!runtime.attached) {
      runtime.term.open(node);
      runtime.attached = true;
      // 设置textarea的样式，防止滚动跳转
      const textarea = runtime.term.textarea;
      if (textarea) {
        textarea.style.scrollMargin = '0px';
        textarea.style.position = 'absolute';
        // 监听textarea的focus事件，阻止页面滚动
        textarea.addEventListener('focus', (e) => {
          e.preventDefault();
          // 保持terminal内部滚动到底部
          setTimeout(() => {
            try {
              runtime.term.scrollToBottom();
            } catch (error) {
              console.warn('scroll on focus skipped', error);
            }
          }, 0);
        }, { passive: false });
      }
    }
    try {
      runtime.fitAddon.fit();
    } catch (error) {
      console.warn("fit skipped", error);
    }
    const observer = new ResizeObserver(() => {
      try {
        runtime.fitAddon.fit();
      } catch (error) {
        console.warn("observer fit skipped", error);
      }
    });
    runtime.observer = observer;
    observer.observe(node);
  }, []);

  useEffect(() => {
    let cancelled = false;
    const hydrateAndConnect = async () => {
      if (!sessionId) {
        statusCallbackRef.current?.("idle");
        return;
      }
      const runtime = ensureRuntime(sessionId);
      try {
        const { content } = await api.fetchLogs(sessionId);
        if (cancelled) {
          return;
        }
        if (content) {
          runtime.term.reset();
          safeWrite(runtime.term, content, () => {
            requestAnimationFrame(() => {
              try {
                runtime.fitAddon.fit();
                runtime.term.scrollToBottom();
              } catch (error) {
                console.warn("history fit skipped", error);
              }
            });
          });
        } else {
          runtime.term.reset();
        }
      } catch (error) {
        console.warn("load history failed", error);
      } finally {
        if (!cancelled) {
          connectRuntime(runtime);
        }
      }
    };
    hydrateAndConnect();
    return () => {
      cancelled = true;
    };
  }, [connectRuntime, ensureRuntime, sessionId]);

  useEffect(() => {
    if (!sessionIds.length) {
      const ids = Array.from(runtimesRef.current.keys());
      ids.forEach(disposeRuntime);
      setMountedSessions([]);
      statusCallbackRef.current?.("idle");
      return;
    }
    const allowed = new Set(sessionIds);
    let removed = false;
    runtimesRef.current.forEach((_runtime, id) => {
      if (!allowed.has(id)) {
        disposeRuntime(id);
        removed = true;
      }
    });
    if (removed) {
      setMountedSessions((prev) => prev.filter((id) => allowed.has(id)));
    }
  }, [disposeRuntime, sessionIds]);

  useEffect(
    () => () => {
      const ids = Array.from(runtimesRef.current.keys());
      ids.forEach(disposeRuntime);
    },
    [disposeRuntime],
  );

  useEffect(() => {
    if (!sessionId) {
      return;
    }
    const runtime = runtimesRef.current.get(sessionId);
    if (!runtime) {
      return;
    }
    // 阻止浏览器自动滚动到焦点元素，防止页面跳转
    const textarea = runtime.term.textarea;
    if (textarea) {
      // 使用preventScroll防止浏览器自动滚动
      textarea.focus({ preventScroll: true });
    } else {
      // fallback: 如果textarea不可用，直接focus terminal
      runtime.term.focus();
    }
    requestAnimationFrame(() => {
      try {
        runtime.fitAddon.fit();
        runtime.term.scrollToBottom();
      } catch (error) {
        console.warn("active fit skipped", error);
      }
    });
  }, [sessionId]);

  const showPlaceholder = !sessionId || mountedSessions.length === 0;

  return (
    <div className="xterm-theme live-terminal-wrapper">
      <div className="terminal-stack">
        {mountedSessions.map((id) => (
          <div
            key={id}
            className="terminal-instance"
            data-active={sessionId === id}
            ref={(node) => attachContainer(id, node)}
          />
        ))}
        {showPlaceholder && (
          <div className="terminal-placeholder">
            <p>{note || "请选择一个会话以查看输出。"}</p>
          </div>
        )}
      </div>
    </div>
  );
};

const ReplayTerminal = ({ logContent, note }: ReplayTerminalProps) => {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);

  useEffect(() => {
    const term = new Terminal({
      cursorBlink: false,
      disableStdin: true,
      scrollback: 5000,
      fontSize: 14,
      fontFamily: '"Cascadia Code", "Fira Code", monospace',
      convertEol: false,
      theme: {
        background: "#0f172a",
        foreground: "#f8fafc",
        black: "#1e293b",
        green: "#22c55e",
        blue: "#38bdf8",
      },
    });
    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    termRef.current = term;
    fitRef.current = fitAddon;
    if (containerRef.current) {
      term.open(containerRef.current);
      try {
        fitAddon.fit();
      } catch (error) {
        console.warn("replay fit skipped", error);
      }
    }
    const observer = new ResizeObserver(() => {
      try {
        fitAddon.fit();
      } catch (error) {
        console.warn("replay observer fit skipped", error);
      }
    });
    if (containerRef.current) {
      observer.observe(containerRef.current);
    }
    return () => {
      observer.disconnect();
      term.dispose();
    };
  }, []);

  useEffect(() => {
    const term = termRef.current;
    if (!term) {
      return;
    }
    term.reset();
    const intro = note ? `${note}\r\n\r\n` : "以下内容为历史日志：\r\n\r\n";
    const body = logContent ?? "暂无日志内容。";
    safeWrite(term, intro + body, () => {
      requestAnimationFrame(() => {
        try {
          fitRef.current?.fit();
          term.scrollToBottom();
        } catch (error) {
          console.warn("replay resize skipped", error);
        }
      });
    });
  }, [logContent, note]);

  return <div ref={containerRef} className="xterm-theme terminal-replay-wrapper" />;
};

export default TerminalPanel;
