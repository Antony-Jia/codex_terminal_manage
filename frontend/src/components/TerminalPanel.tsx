import { message } from "antd";
import { useEffect, useRef } from "react";
import { Terminal } from "xterm";
import { FitAddon } from "xterm-addon-fit";
import { websocketUrl } from "../api";

export type TerminalStatus = "idle" | "connecting" | "connected" | "closed" | "error";

interface TerminalPanelProps {
  sessionId?: string;
  onStatusChange?: (status: TerminalStatus) => void;
}

const TerminalPanel = ({ sessionId, onStatusChange }: TerminalPanelProps) => {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const socketRef = useRef<WebSocket | null>(null);

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
      fitAddon.fit();
    }
    term.writeln("欢迎使用浏览器终端，请先选择配置并创建会话。\r\n");
    terminalRef.current = term;
    fitAddonRef.current = fitAddon;

    const handleResize = () => fitAddonRef.current?.fit();
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
  }, []);

  useEffect(() => {
    const term = terminalRef.current;
    if (!term) {
      return;
    }
    socketRef.current?.close();
    term.reset();
    if (!sessionId) {
      term.writeln("请在左侧选择环境并点击\"启动会话\"。\r\n");
      onStatusChange?.("idle");
      return;
    }
    const ws = new WebSocket(websocketUrl(sessionId));
    socketRef.current = ws;
    onStatusChange?.("connecting");

    ws.onopen = () => {
      onStatusChange?.("connected");
      term.writeln(`已连接到会话 ${sessionId}\r\n`);
    };

    ws.onmessage = (event) => {
      try {
        const payload = JSON.parse(event.data);
        if (payload.type === "output") {
          term.write(payload.data);
        }
      } catch (error) {
        term.write(String(event.data));
      }
    };

    ws.onclose = () => {
      onStatusChange?.("closed");
      term.writeln("\r\n连接已关闭\r\n");
    };

    ws.onerror = () => {
      message.error("终端连接异常");
      onStatusChange?.("error");
    };

    return () => {
      ws.close();
    };
  }, [sessionId, onStatusChange]);

  useEffect(() => {
    const observer = new ResizeObserver(() => {
      fitAddonRef.current?.fit();
    });
    if (containerRef.current) {
      observer.observe(containerRef.current);
    }
    return () => observer.disconnect();
  }, []);

  return <div ref={containerRef} style={{ width: "100%", height: 520 }} className="xterm-theme" />;
};

export default TerminalPanel;
