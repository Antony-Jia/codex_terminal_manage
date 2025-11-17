from __future__ import annotations

import json
from datetime import datetime
from typing import Any, Optional

from sqlalchemy import Column, DateTime, ForeignKey, Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column, relationship

from .db import Base


class SessionStatus:
    RUNNING = "running"
    COMPLETED = "completed"
    STOPPED = "stopped"
    ERROR = "error"
    INTERRUPTED = "interrupted"

    FINAL_STATES = {COMPLETED, STOPPED, ERROR, INTERRUPTED}


class SessionProfile(Base):
    __tablename__ = "session_profiles"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)
    name: Mapped[str] = mapped_column(String(120), nullable=False, unique=True)
    command: Mapped[str] = mapped_column(String(255), nullable=False)
    args: Mapped[str] = mapped_column(Text, nullable=False, default="[]")
    cwd: Mapped[Optional[str]] = mapped_column(String(500), nullable=True)
    env_json: Mapped[str] = mapped_column(Text, nullable=False, default="{}")
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, nullable=False)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, default=datetime.utcnow, onupdate=datetime.utcnow, nullable=False
    )

    sessions: Mapped[list["SessionRecord"]] = relationship("SessionRecord", back_populates="profile")

    def args_list(self) -> list[str]:
        try:
            data = json.loads(self.args or "[]")
            return list(data) if isinstance(data, list) else []
        except json.JSONDecodeError:
            return []

    def env_dict(self) -> dict[str, str]:
        try:
            data: Any = json.loads(self.env_json or "{}")
            return {str(k): str(v) for k, v in data.items()} if isinstance(data, dict) else {}
        except json.JSONDecodeError:
            return {}


class SessionRecord(Base):
    __tablename__ = "sessions"

    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    profile_id: Mapped[int] = mapped_column(ForeignKey("session_profiles.id"), nullable=False)
    cwd: Mapped[Optional[str]] = mapped_column(String(500), nullable=True)
    log_path: Mapped[str] = mapped_column(String(500), nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, nullable=False)
    finished_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
    status: Mapped[str] = mapped_column(String(32), default=SessionStatus.RUNNING, nullable=False)
    exit_code: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)

    profile: Mapped[SessionProfile] = relationship("SessionProfile", back_populates="sessions")
