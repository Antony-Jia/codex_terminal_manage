from __future__ import annotations

from datetime import datetime
from typing import Any, Optional

from pydantic import BaseModel, Field, validator


class ProfileBase(BaseModel):
    name: str = Field(..., max_length=120)
    command: str
    args: list[str] = Field(default_factory=list)
    cwd: Optional[str] = None
    env: dict[str, str] = Field(default_factory=dict)

    @validator("args", pre=True)
    def ensure_list(cls, value: Any):  # type: ignore[override]
        if value is None:
            return []
        if isinstance(value, str):
            return [value]
        return list(value)


class ProfileCreate(ProfileBase):
    pass


class ProfileUpdate(BaseModel):
    name: Optional[str] = None
    command: Optional[str] = None
    args: Optional[list[str]] = None
    cwd: Optional[str] = None
    env: Optional[dict[str, str]] = None


class ProfileRead(ProfileBase):
    id: int
    created_at: datetime
    updated_at: datetime

    class Config:
        from_attributes = True


class SessionCreateRequest(BaseModel):
    profile_id: int


class SessionCreateResponse(BaseModel):
    session_id: str
    profile: ProfileRead
    cwd: str
    log_path: str


class SessionRecordRead(BaseModel):
    id: str
    profile_id: int
    cwd: Optional[str]
    log_path: str
    created_at: datetime

    class Config:
        from_attributes = True


class GitStatusEntry(BaseModel):
    path: str
    status: str


class GitChangesResponse(BaseModel):
    git: bool
    message: Optional[str] = None
    status: Optional[list[GitStatusEntry]] = None
    diff_stat: Optional[str] = None


class GitDeltaBlock(BaseModel):
    added: list[str] = Field(default_factory=list)
    deleted: list[str] = Field(default_factory=list)
    updated: list[str] = Field(default_factory=list)
    status_changed: list[str] = Field(default_factory=list)


class LogResponse(BaseModel):
    session_id: str
    content: str

