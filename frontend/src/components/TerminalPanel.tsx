import { message } from "antd";
import { useCallback, useEffect, useRef, useState } from "react";
import { Terminal, type IDisposable } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
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
    lineHeight: 1.2,
    rightClickSelectsWord: true,
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
  const runtime: SessionRuntime = {
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

  let resizeTimeout: number | undefined;
  term.onResize((size) => {
    if (resizeTimeout) {
      window.clearTimeout(resizeTimeout);
    }
    resizeTimeout = window.setTimeout(() => {
      console.log("Terminal resized:", size);
      if (runtime.socket?.readyState === WebSocket.OPEN && size.cols > 0 && size.rows > 0) {
        runtime.socket.send(
          JSON.stringify({
            type: "resize",
            cols: size.cols,
            rows: size.rows,
          })
        );
      }
    }, 66);
  });

  return runtime;
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
        // 在写入完成后延迟滚动，让渲染完成后再滚动到底部
        requestAnimationFrame(() => {
          try {
            runtime.term.scrollToBottom();
            // 双重保险：再次确保滚动到底部
            requestAnimationFrame(() => {
              try {
                runtime.term.scrollToBottom();
              } catch (error) {
                console.warn("delayed scroll skipped", error);
              }
            });
          } catch (error) {
            console.warn("immediate scroll skipped", error);
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
        // Force a fit calculation to ensure we have the correct dimensions
        try {
            runtime.fitAddon.fit();
        } catch (e) {
            console.warn("Initial fit failed", e);
        }
        
        const sendResize = () => {
          if (socket.readyState === WebSocket.OPEN && runtime.term.cols > 0 && runtime.term.rows > 0) {
            console.log("Sending initial resize:", runtime.term.cols, runtime.term.rows);
            socket.send(
              JSON.stringify({
                type: "resize",
                cols: runtime.term.cols,
                rows: runtime.term.rows,
              })
            );
          }
        };
        sendResize();
        // 再次延迟发送，以防初始化时尺寸不准确
        setTimeout(sendResize, 500);
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
            // 延迟滚动到底部，确保渲染完成后再滚动
            requestAnimationFrame(() => {
              try {
                runtime.term.scrollToBottom();
              } catch (error) {
                console.warn("scroll to bottom skipped", error);
              }
            });
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
      // 设置 textarea 的 scrollMargin，避免浏览器因聚焦自动滚动页面
      const textarea = runtime.term.textarea;
      if (textarea) {
        textarea.style.scrollMargin = "0px";
      }
    }
    try {
      runtime.fitAddon.fit();
      // Double check fit after a short delay to ensure layout is settled
      setTimeout(() => {
        try {
          runtime.fitAddon.fit();
        } catch (e) {
          // ignore
        }
      }, 100);
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
      <div className="terminal-shell">
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
        setTimeout(() => {
            try {
                fitAddon.fit();
            } catch (e) {
                // ignore
            }
        }, 100);
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

  return (
    <div className="xterm-theme terminal-replay-wrapper">
      <div className="terminal-shell">
        <div ref={containerRef} className="terminal-replay-canvas" />
      </div>
    </div>
  );
};

export default TerminalPanel;
