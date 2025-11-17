from __future__ import annotations

import asyncio
import json
import logging
from pathlib import Path
import os
from typing import Optional

from fastapi import Depends, FastAPI, HTTPException, Response, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from .core.config import get_settings
from .db import Base, engine, get_db, session_scope
from .models import SessionProfile, SessionRecord
from .schemas import (
    GitChangesResponse,
    GitStatusEntry,
    LogResponse,
    ProfileCreate,
    ProfileRead,
    ProfileUpdate,
    SessionCreateRequest,
    SessionCreateResponse,
)
from .services.session_manager import SessionManager
from .utils.git import collect_git_overview

# Windows 平台需要设置事件循环策略以支持子进程
if os.name == "nt":
    asyncio.set_event_loop_policy(asyncio.WindowsSelectorEventLoopPolicy())

settings = get_settings()
app = FastAPI(title=settings.app_name)

# 配置日志
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
    allow_credentials=True,
)

session_manager = SessionManager()


def profile_to_schema(profile: SessionProfile) -> ProfileRead:
    return ProfileRead(
        id=profile.id,
        name=profile.name,
        command=profile.command,
        args=profile.args_list(),
        cwd=profile.cwd,
        env=profile.env_dict(),
        created_at=profile.created_at,
        updated_at=profile.updated_at,
    )


def seed_default_profile() -> None:
    with session_scope() as db:
        exists = db.execute(select(SessionProfile).where(SessionProfile.name == settings.default_profile_name)).scalar_one_or_none()
        if exists:
            return
        default_profile = SessionProfile(
            name=settings.default_profile_name,
            command=settings.default_profile_command,
            args=json.dumps([]),
            cwd=str(settings.resolved_default_cwd),
            env_json=json.dumps({}),
        )
        db.add(default_profile)


@app.on_event("startup")
async def on_startup() -> None:
    Base.metadata.create_all(bind=engine)
    await asyncio.get_event_loop().run_in_executor(None, seed_default_profile)


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.get("/profiles", response_model=list[ProfileRead])
def list_profiles(db: Session = Depends(get_db)):
    logger.info("收到 /profiles 请求")
    profiles = db.execute(select(SessionProfile).order_by(SessionProfile.id)).scalars().all()
    logger.info(f"返回 {len(profiles)} 个配置")
    return [profile_to_schema(p) for p in profiles]


@app.post("/profiles", response_model=ProfileRead, status_code=201)
def create_profile(payload: ProfileCreate, db: Session = Depends(get_db)):
    profile = SessionProfile(
        name=payload.name,
        command=payload.command,
        args=json.dumps(payload.args),
        cwd=payload.cwd,
        env_json=json.dumps(payload.env),
    )
    db.add(profile)
    try:
        db.commit()
    except IntegrityError as exc:
        db.rollback()
        raise HTTPException(status_code=400, detail="配置名称已存在") from exc
    db.refresh(profile)
    return profile_to_schema(profile)


@app.put("/profiles/{profile_id}", response_model=ProfileRead)
def update_profile(profile_id: int, payload: ProfileUpdate, db: Session = Depends(get_db)):
    profile = db.get(SessionProfile, profile_id)
    if not profile:
        raise HTTPException(status_code=404, detail="配置不存在")
    if payload.name is not None:
        profile.name = payload.name
    if payload.command is not None:
        profile.command = payload.command
    if payload.args is not None:
        profile.args = json.dumps(payload.args)
    if payload.cwd is not None:
        profile.cwd = payload.cwd
    if payload.env is not None:
        profile.env_json = json.dumps(payload.env)
    try:
        db.commit()
    except IntegrityError as exc:
        db.rollback()
        raise HTTPException(status_code=400, detail="配置名称已存在") from exc
    db.refresh(profile)
    return profile_to_schema(profile)


@app.delete("/profiles/{profile_id}", status_code=204)
def delete_profile(profile_id: int, db: Session = Depends(get_db)):
    profile = db.get(SessionProfile, profile_id)
    if not profile:
        raise HTTPException(status_code=404, detail="配置不存在")
    db.delete(profile)
    db.commit()
    return Response(status_code=204)


@app.post("/sessions", response_model=SessionCreateResponse, status_code=201)
async def create_session(payload: SessionCreateRequest, db: Session = Depends(get_db)):
    profile = db.get(SessionProfile, payload.profile_id)
    if not profile:
        raise HTTPException(status_code=404, detail="配置不存在")
    context = await session_manager.create_session(profile)
    record = SessionRecord(
        id=context.session_id,
        profile_id=profile.id,
        cwd=str(context.cwd),
        log_path=str(context.log_path),
    )
    db.add(record)
    db.commit()
    response = SessionCreateResponse(
        session_id=context.session_id,
        profile=profile_to_schema(profile),
        cwd=str(context.cwd),
        log_path=str(context.log_path),
    )
    return response


@app.get("/logs/{session_id}", response_model=LogResponse)
def fetch_log(session_id: str, db: Session = Depends(get_db)):
    content = session_manager.get_log_text(session_id)
    if content is None:
        record = db.get(SessionRecord, session_id)
        if not record:
            raise HTTPException(status_code=404, detail="Session 未找到")
        log_file = Path(record.log_path)
        if not log_file.exists():
            raise HTTPException(status_code=404, detail="日志文件不存在")
        content = log_file.read_text(encoding="utf-8", errors="ignore")
    return LogResponse(session_id=session_id, content=content)


@app.get("/git_changes/{session_id}", response_model=GitChangesResponse)
async def git_changes(session_id: str, db: Session = Depends(get_db)):
    context_cwd: Optional[Path] = None
    if session_manager.has_session(session_id):
        context_cwd = session_manager.get(session_id).cwd
    else:
        record = db.get(SessionRecord, session_id)
        if record and record.cwd:
            context_cwd = Path(record.cwd)
    if context_cwd is None:
        raise HTTPException(status_code=404, detail="Session 未找到")
    git_dir = context_cwd / ".git"
    if not git_dir.exists():
        return GitChangesResponse(git=False, message="not a git repository")
    status_rows, diff_stat = await collect_git_overview(context_cwd)
    status = None
    if status_rows is not None:
        status = [GitStatusEntry(status=row[0], path=row[1]) for row in status_rows]
    return GitChangesResponse(
        git=True,
        status=status,
        diff_stat=diff_stat,
        message=None,
    )


@app.websocket("/ws/sessions/{session_id}")
async def session_socket(websocket: WebSocket, session_id: str):
    try:
        await session_manager.attach(session_id, websocket)
    except KeyError:
        await websocket.close(code=4404)
        return
    try:
        while True:
            payload = await websocket.receive_json()
            msg_type = payload.get("type")
            if msg_type == "input":
                await session_manager.send_input(session_id, payload.get("data", ""))
            elif msg_type == "ping":
                await websocket.send_json({"type": "pong"})
    except WebSocketDisconnect:
        await session_manager.detach(session_id, websocket)
    except Exception as exc:
        await websocket.send_json({"type": "output", "data": f"\r\n错误: {exc}\r\n"})
        await session_manager.detach(session_id, websocket)
