from __future__ import annotations

import asyncio
import json
import logging
import os
from datetime import datetime
from pathlib import Path
from typing import Optional

from fastapi import Depends, FastAPI, HTTPException, Response, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from sqlalchemy import select, text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from .core.config import get_settings
from .db import Base, engine, get_db, session_scope
from .models import SessionProfile, SessionRecord, SessionStatus
from .schemas import (
    GitChangesResponse,
    GitStatusEntry,
    LogResponse,
    ProfileCreate,
    ProfileRead,
    ProfileUpdate,
    SessionCreateRequest,
    SessionInfo,
    SessionCreateResponse,
    SessionSummary,
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


def ensure_session_columns() -> None:
    if not settings.resolved_database_url.startswith("sqlite"):
        return
    with engine.begin() as conn:
        existing = {row[1] for row in conn.execute(text("PRAGMA table_info('sessions')")).fetchall()}
        if "status" not in existing:
            conn.execute(text("ALTER TABLE sessions ADD COLUMN status TEXT DEFAULT 'running'"))
        if "finished_at" not in existing:
            conn.execute(text("ALTER TABLE sessions ADD COLUMN finished_at TEXT"))
        if "exit_code" not in existing:
            conn.execute(text("ALTER TABLE sessions ADD COLUMN exit_code INTEGER"))


def mark_orphan_sessions() -> None:
    with session_scope() as db:
        updated = (
            db.query(SessionRecord)
            .filter(SessionRecord.status == SessionStatus.RUNNING)
            .update(
                {
                    SessionRecord.status: SessionStatus.INTERRUPTED,
                    SessionRecord.finished_at: datetime.utcnow(),
                },
                synchronize_session=False,
            )
        )
        if updated:
            logger.info("更新 %s 个未完成的会话状态为 interrupted", updated)


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
    loop = asyncio.get_event_loop()
    await loop.run_in_executor(None, ensure_session_columns)
    await loop.run_in_executor(None, mark_orphan_sessions)
    await loop.run_in_executor(None, seed_default_profile)


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
    quantity = max(1, min(payload.quantity, 10))
    records: list[SessionRecord] = []
    for _ in range(quantity):
        context = await session_manager.create_session(profile)
        record = SessionRecord(
            id=context.session_id,
            profile_id=profile.id,
            cwd=str(context.cwd),
            log_path=str(context.log_path),
            status=SessionStatus.RUNNING,
        )
        db.add(record)
        records.append(record)
    db.commit()
    for record in records:
        db.refresh(record)
    profile_schema = profile_to_schema(profile)
    items = [
        SessionInfo(
            session_id=record.id,
            profile=profile_schema,
            status=record.status,
            exit_code=record.exit_code,
            cwd=record.cwd,
            log_path=record.log_path,
            created_at=record.created_at,
            finished_at=record.finished_at,
        )
        for record in records
    ]
    return SessionCreateResponse(sessions=items)


@app.get("/sessions", response_model=list[SessionSummary])
def list_sessions(db: Session = Depends(get_db)):
    stmt = (
        select(SessionRecord, SessionProfile)
        .join(SessionProfile, SessionRecord.profile_id == SessionProfile.id)
        .order_by(SessionRecord.created_at.desc())
    )
    rows = db.execute(stmt).all()
    summaries: list[SessionSummary] = []
    for record, profile in rows:
        summaries.append(
            SessionSummary(
                session_id=record.id,
                profile=profile_to_schema(profile),
                status=record.status,
                exit_code=record.exit_code,
                cwd=record.cwd,
                log_path=record.log_path,
                created_at=record.created_at,
                finished_at=record.finished_at,
            )
        )
    return summaries


@app.get("/logs/{session_id}", response_model=LogResponse)
def fetch_log(session_id: str, db: Session = Depends(get_db)):
    record = db.get(SessionRecord, session_id)
    if not record:
        raise HTTPException(status_code=404, detail="Session 未找到")
    content = session_manager.get_log_text(session_id)
    if content is None:
        log_file = Path(record.log_path)
        if not log_file.exists():
            raise HTTPException(status_code=404, detail="日志文件不存在")
        content = log_file.read_text(encoding="utf-8", errors="ignore")
    active = session_manager.is_active(session_id)
    historical = record.status != SessionStatus.RUNNING or not active
    message = "以下内容来自历史日志，仅供回放。" if historical else None
    return LogResponse(session_id=session_id, content=content, historical=historical, message=message)


@app.delete("/sessions/{session_id}", status_code=204)
async def delete_session(session_id: str, db: Session = Depends(get_db)):
    record = db.get(SessionRecord, session_id)
    if not record:
        raise HTTPException(status_code=404, detail="Session 未找到")
    if session_manager.has_session(session_id):
        await session_manager.terminate_session(session_id, reason="会话已删除")
    log_path = record.log_path
    db.delete(record)
    db.commit()
    remove_log_artifacts(log_path)
    return Response(status_code=204)


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
def remove_log_artifacts(log_path_str: str) -> None:
    try:
        log_path = Path(log_path_str)
    except Exception:
        return
    try:
        if log_path.exists() and log_path.is_file():
            log_path.unlink()
        log_dir = log_path.parent
        if log_dir.exists() and not any(log_dir.iterdir()):
            log_dir.rmdir()
    except Exception:
        pass
