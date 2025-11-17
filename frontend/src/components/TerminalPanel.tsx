import { message } from "antd";
import { useCallback, useEffect, useRef } from "react";
import { Terminal } from "xterm";
import { FitAddon } from "xterm-addon-fit";
import { websocketUrl } from "../api";

export type TerminalStatus = "idle" | "connecting" | "connected" | "closed" | "error";
export type TerminalMode = "idle" | "live" | "replay";

interface TerminalPanelProps {
  sessionId?: string;
  mode?: TerminalMode;
  logContent?: string;
  note?: string;
  onStatusChange?: (status: TerminalStatus) => void;
}

const TerminalPanel = ({ sessionId, mode = "idle", logContent, note, onStatusChange }: TerminalPanelProps) => {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const socketRef = useRef<WebSocket | null>(null);

  const safeWrite = useCallback((text: string) => {
    const term = terminalRef.current;
    if (!term) {
      return;
    }
    try {
      term.write(text);
    } catch (error) {
      console.warn("terminal write skipped", error);
    }
  }, []);

  const safeWriteln = useCallback(
    (text: string) => {
      safeWrite(`${text}\r\n`);
    },
    [safeWrite],
  );

  useEffect(() => {
    const term = new Terminal({
      cursorBlink: true,
      fontSize: 14,
      fontFamily: '"Cascadia Code", "Fira Code", monospace',
      convertEol: true,
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
    if (containerRef.current) {
      term.open(containerRef.current);
      try {
        fitAddon.fit();
      } catch (error) {
        console.warn("initial fit skipped", error);
      }
    }
    safeWriteln("欢迎使用浏览器终端，请先选择配置并创建会话。");
    terminalRef.current = term;
    fitAddonRef.current = fitAddon;

    const handleResize = () => {
      try {
        fitAddonRef.current?.fit();
      } catch (error) {
        console.warn("resize fit skipped", error);
      }
    };
    window.addEventListener("resize", handleResize);
    const subscription = term.onData((data) => {
      const socket = socketRef.current;
      if (socket?.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: "input", data }));
      }
    });

    return () => {
      subscription.dispose();
      window.removeEventListener("resize", handleResize);
      socketRef.current?.close();
      term.dispose();
    };
  }, [safeWriteln]);

  useEffect(() => {
    const term = terminalRef.current;
    if (!term) {
      return;
    }
    socketRef.current?.close();
    if (mode === "live" && sessionId) {
      term.reset();
      onStatusChange?.("connecting");
      const ws = new WebSocket(websocketUrl(sessionId));
      socketRef.current = ws;
      ws.onopen = () => {
        onStatusChange?.("connected");
        safeWriteln(`已连接到会话 ${sessionId}`);
      };
      ws.onmessage = (event) => {
        const raw = event.data;
        if (typeof raw === "string") {
          try {
            const payload = JSON.parse(raw);
            if (payload?.type === "output") {
              safeWrite(payload.data);
              return;
            }
          } catch (error) {
            // fall through to write raw text
          }
          safeWrite(raw);
        } else if (raw instanceof Blob) {
          raw.text().then((text) => safeWrite(text));
        } else if (raw instanceof ArrayBuffer) {
          safeWrite(new TextDecoder().decode(raw));
        }
      };
      ws.onclose = () => {
        onStatusChange?.("closed");
        safeWriteln("");
        safeWriteln("连接已关闭");
      };
      ws.onerror = () => {
        message.error("终端连接异常");
        onStatusChange?.("error");
      };
      return () => ws.close();
    }

    onStatusChange?.("idle");
    if (mode !== "replay") {
      term.reset();
      const introMessage = note || "请选择一个会话以查看输出。";
      safeWriteln(introMessage);
    }
  }, [mode, sessionId, onStatusChange, note, safeWrite, safeWriteln]);

  useEffect(() => {
    if (mode !== "replay") {
      return;
    }
    const term = terminalRef.current;
    if (!term) {
      return;
    }
    term.reset();
    const introMessage = note || "以下内容为历史日志：";
    safeWriteln(introMessage);
    if (logContent) {
      safeWrite(logContent);
    } else {
      safeWriteln("暂无日志内容。");
    }
  }, [mode, logContent, note, safeWrite, safeWriteln]);

  useEffect(() => {
    const observer = new ResizeObserver(() => {
      try {
        fitAddonRef.current?.fit();
      } catch (error) {
        console.warn("observer fit skipped", error);
      }
    });
    if (containerRef.current) {
      observer.observe(containerRef.current);
    }
    return () => observer.disconnect();
  }, []);

  return <div ref={containerRef} style={{ width: "100%", height: 520 }} className="xterm-theme" />;
};

export default TerminalPanel;
