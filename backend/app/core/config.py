from __future__ import annotations

import os
from functools import lru_cache
from pathlib import Path

from typing import Optional

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """Application level configuration sourced from env variables."""

    model_config = SettingsConfigDict(
        env_prefix="TERMINAL_MANAGE_",
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )

    app_name: str = "Codex Terminal Manage"
    base_dir: Path = Field(default_factory=lambda: Path(__file__).resolve().parents[3])
    data_dir: Optional[Path] = None
    logs_dir: Optional[Path] = None
    database_url: Optional[str] = None
    default_cwd: Optional[Path] = None
    default_profile_command: str = "pwsh" if os.name == "nt" else "bash"
    default_profile_name: str = "默认 PowerShell"
    git_diff_delay: float = 0.35

    @property
    def resolved_data_dir(self) -> Path:
        directory = self.data_dir or self.base_dir / "backend" / "data"
        directory.mkdir(parents=True, exist_ok=True)
        return directory

    @property
    def resolved_logs_dir(self) -> Path:
        directory = self.logs_dir or self.base_dir / "backend" / "logs"
        directory.mkdir(parents=True, exist_ok=True)
        return directory

    @property
    def resolved_database_url(self) -> str:
        if self.database_url:
            return self.database_url
        db_path = self.resolved_data_dir / "terminal_manage.db"
        return f"sqlite:///{db_path.as_posix()}"

    @property
    def resolved_default_cwd(self) -> Path:
        return self.default_cwd or self.base_dir


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    return Settings()
