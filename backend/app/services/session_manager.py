from __future__ import annotations

import asyncio
import os
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from typing import BinaryIO, Dict, Optional
from uuid import uuid4
import subprocess

from fastapi import WebSocket

from ..core.config import get_settings
from ..db import session_scope
from ..models import SessionRecord, SessionStatus
from ..utils import git

settings = get_settings()


@dataclass
class SessionContext:
    session_id: str
    profile_id: int
    command: list[str]
    cwd: Path
    env: dict[str, str]
    log_path: Path
    process: Optional[subprocess.Popen] = None
    stdout_task: Optional[asyncio.Task] = None
    stderr_task: Optional[asyncio.Task] = None
    monitor_task: Optional[asyncio.Task] = None
    sockets: set[WebSocket] = field(default_factory=set)
    log_file: Optional[BinaryIO] = None
    command_buffer: str = ""
    cwd_has_git: bool = False
    lock: asyncio.Lock = field(default_factory=asyncio.Lock)

    def close_log(self) -> None:
        if self.log_file:
            try:
                self.log_file.close()
            finally:
                self.log_file = None

    def cleanup_tasks(self) -> None:
        for task in (self.stdout_task, self.stderr_task, self.monitor_task):
            if task and not task.done():
                task.cancel()
        self.stdout_task = self.stderr_task = self.monitor_task = None


class SessionManager:
    def __init__(self) -> None:
        self._sessions: Dict[str, SessionContext] = {}
        self._base_env = os.environ.copy()

    def get(self, session_id: str) -> SessionContext:
        context = self._sessions.get(session_id)
        if not context:
            raise KeyError(f"Session {session_id} not found")
        return context

    def has_session(self, session_id: str) -> bool:
        return session_id in self._sessions

    def is_active(self, session_id: str) -> bool:
        context = self._sessions.get(session_id)
        return bool(context and context.process and context.process.poll() is None)

    async def create_session(self, profile) -> SessionContext:
        session_id = str(uuid4())
        cwd = Path(profile.cwd or settings.resolved_default_cwd)
        command = [profile.command or settings.default_profile_command]
        command.extend(profile.args_list())
        env = self._base_env.copy()
        env.update(profile.env_dict())
        log_dir = settings.resolved_logs_dir / session_id
        log_dir.mkdir(parents=True, exist_ok=True)
        log_path = log_dir / "raw.log"
        context = SessionContext(
            session_id=session_id,
            profile_id=profile.id,
            command=command,
            cwd=cwd,
            env=env,
            log_path=log_path,
            cwd_has_git=(cwd / ".git").exists(),
        )
        self._sessions[session_id] = context
        return context

    async def attach(self, session_id: str, websocket: WebSocket) -> SessionContext:
        context = self.get(session_id)
        await websocket.accept()
        context.sockets.add(websocket)
        if context.process is None:
            await self._launch_process(context)
        return context

    async def detach(self, session_id: str, websocket: WebSocket) -> None:
        context = self._sessions.get(session_id)
        if not context:
            return
        context.sockets.discard(websocket)

    async def terminate_session(self, session_id: str, reason: Optional[str] = None) -> None:
        context = self._sessions.get(session_id)
        if not context:
            return
        if context.process and context.process.poll() is None:
            loop = asyncio.get_running_loop()
            def _terminate() -> None:
                try:
                    context.process.terminate()
                    context.process.wait(timeout=2)
                except Exception:
                    try:
                        context.process.kill()
                    except Exception:
                        pass
            await loop.run_in_executor(None, _terminate)
        context.close_log()
        context.cleanup_tasks()
        context.process = None
        if reason:
            await self._broadcast_text(context, f"\r\n{reason}\r\n")
        await self._update_session_record(session_id, status=SessionStatus.STOPPED)
        self._sessions.pop(session_id, None)

    async def _launch_process(self, context: SessionContext) -> None:
        loop = asyncio.get_running_loop()

        def _spawn() -> subprocess.Popen:
            return subprocess.Popen(
                context.command,
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                cwd=str(context.cwd),
                env=context.env,
                bufsize=0,
            )

        context.process = await loop.run_in_executor(None, _spawn)
        context.log_file = open(context.log_path, "ab", buffering=0)
        context.stdout_task = asyncio.create_task(self._pump_stream(context, context.process.stdout))
        context.stderr_task = asyncio.create_task(self._pump_stream(context, context.process.stderr))
        context.monitor_task = asyncio.create_task(self._monitor(context))

    async def _pump_stream(self, context: SessionContext, stream) -> None:
        if stream is None:
            return
        loop = asyncio.get_running_loop()

        def _read() -> bytes:
            try:
                return stream.read1(1024)
            except (AttributeError, ValueError):
                return stream.read(1024)

        while True:
            data = await loop.run_in_executor(None, _read)
            if not data:
                break
            self._write_log(context, data)
            text = data.decode("utf-8", errors="ignore")
            await self._broadcast_text(context, text)

    async def _monitor(self, context: SessionContext) -> None:
        if not context.process:
            return
        loop = asyncio.get_running_loop()
        return_code = await loop.run_in_executor(None, context.process.wait)
        status = SessionStatus.COMPLETED if return_code == 0 else SessionStatus.ERROR
        await self._broadcast_text(context, f"\r\nProcess finished with code {return_code}\r\n")
        context.close_log()
        context.process = None
        context.monitor_task = None
        await self._update_session_record(context.session_id, status=status, exit_code=return_code)
        self._sessions.pop(context.session_id, None)

    def _write_log(self, context: SessionContext, data: bytes) -> None:
        if context.log_file:
            context.log_file.write(data)

    async def _broadcast_text(self, context: SessionContext, text: str) -> None:
        payload = {"type": "output", "data": text}
        for socket in list(context.sockets):
            try:
                await socket.send_json(payload)
            except Exception:
                context.sockets.discard(socket)

    async def send_input(self, session_id: str, data: str) -> None:
        context = self.get(session_id)
        if context.process is None or context.process.stdin is None:
            raise RuntimeError("进程不可用，无法写入数据")
        async with context.lock:
            await self._process_input(context, data)

    async def _process_input(self, context: SessionContext, data: str) -> None:
        if not data or context.process is None or context.process.stdin is None:
            return
        buffer = bytearray()

        async def flush_buffer() -> None:
            if buffer:
                await self._write_to_process(context, bytes(buffer))
                buffer.clear()

        for char in data:
            if char in {"\u0008", "\u007f"}:  # Backspace/delete
                context.command_buffer = context.command_buffer[:-1]
                buffer.extend(char.encode("utf-8"))
                continue
            if char == "\u0003":  # Ctrl + C
                context.command_buffer = ""
                buffer.extend(char.encode("utf-8"))
                await flush_buffer()
                continue
            if char in {"\r", "\n"}:
                await flush_buffer()
                await self._handle_newline(context, char)
                continue
            context.command_buffer += char
            buffer.extend(char.encode("utf-8"))
        await flush_buffer()

    async def _handle_newline(
        self,
        context: SessionContext,
        char: str,
    ) -> None:
        before_snapshot = None
        command_label = None
        if char == "\r":
            if not context.cwd_has_git and (context.cwd / ".git").exists():
                context.cwd_has_git = True
            if context.cwd_has_git:
                before_snapshot = await git.get_git_status(context.cwd)
                command_label = context.command_buffer.strip()
            context.command_buffer = ""
        payload = b"\r\n" if char == "\r" else char.encode("utf-8")
        await self._write_to_process(context, payload)
        if before_snapshot is None:
            return
        await asyncio.sleep(settings.git_diff_delay)
        after_snapshot = await git.get_git_status(context.cwd)
        if after_snapshot is None:
            context.cwd_has_git = False
            return
        delta = git.diff_status(before_snapshot, after_snapshot)
        if any(delta.values()):
            diff_text = git.format_delta(delta, command_label)
            await self._broadcast_text(context, diff_text + "\r\n")

    async def _write_to_process(self, context: SessionContext, data: bytes) -> None:
        if not data or context.process is None or context.process.stdin is None:
            return
        loop = asyncio.get_running_loop()

        def _write() -> None:
            try:
                context.process.stdin.write(data)
                context.process.stdin.flush()
            except (BrokenPipeError, OSError):
                pass

        await loop.run_in_executor(None, _write)

    def get_log_text(self, session_id: str) -> Optional[str]:
        context = self._sessions.get(session_id)
        log_path = context.log_path if context else None
        if log_path is None or not log_path.exists():
            return None
        data = log_path.read_bytes()
        return data.decode("utf-8", errors="ignore")

    def resolve_log_path(self, session_id: str) -> Optional[Path]:
        context = self._sessions.get(session_id)
        return context.log_path if context else None

    async def _update_session_record(
        self,
        session_id: str,
        status: Optional[str] = None,
        exit_code: Optional[int] = None,
    ) -> None:
        loop = asyncio.get_running_loop()

        def _task() -> None:
            with session_scope() as db:
                record = db.get(SessionRecord, session_id)
                if not record:
                    return
                if status:
                    record.status = status
                    if status in SessionStatus.FINAL_STATES:
                        record.finished_at = datetime.utcnow()
                    elif status == SessionStatus.RUNNING:
                        record.finished_at = None
                if exit_code is not None:
                    record.exit_code = exit_code

        await loop.run_in_executor(None, _task)
