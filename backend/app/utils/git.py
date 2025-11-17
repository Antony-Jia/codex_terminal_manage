from __future__ import annotations

import asyncio
import subprocess
from pathlib import Path
from typing import Dict, List, Optional, Tuple

GIT_BINARY = "git"


async def _run_git(args: list[str], cwd: Path) -> Optional[str]:
    loop = asyncio.get_running_loop()

    def _exec() -> tuple[int, bytes]:
        try:
            completed = subprocess.run(
                [GIT_BINARY, *args],
                cwd=str(cwd),
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                check=False,
            )
            return completed.returncode, completed.stdout
        except FileNotFoundError:
            return 1, b""

    return_code, stdout = await loop.run_in_executor(None, _exec)
    if return_code != 0:
        return None
    return stdout.decode("utf-8", errors="ignore")


async def get_git_status(cwd: Path) -> Optional[dict[str, str]]:
    output = await _run_git(["status", "--short"], cwd)
    if output is None:
        return None
    status: dict[str, str] = {}
    for line in output.splitlines():
        if not line.strip():
            continue
        status_code = line[:2].strip()
        path = line[3:].strip()
        status[path] = status_code
    return status


async def get_git_status_rows(cwd: Path) -> Optional[list[tuple[str, str]]]:
    output = await _run_git(["status", "--short"], cwd)
    if output is None:
        return None
    rows: list[tuple[str, str]] = []
    for line in output.splitlines():
        if not line.strip():
            continue
        rows.append((line[:2].strip(), line[3:].strip()))
    return rows


async def get_git_diff_stat(cwd: Path) -> Optional[str]:
    return await _run_git(["diff", "--stat"], cwd)


def diff_status(before: dict[str, str], after: dict[str, str]) -> dict[str, list[str]]:
    delta = {
        "added": [],
        "modified": [],
        "deleted": [],
    }
    for path, status in after.items():
        if path not in before:
            delta["added"].append(f"{path} ({status})")
        elif before[path] != status:
            delta["modified"].append(f"{path} ({before[path]} -> {status})")
    for path, status in before.items():
        if path not in after:
            delta["deleted"].append(f"{path} ({status})")
    return delta


def format_delta(delta: Dict[str, List[str]], command: Optional[str] = None) -> str:
    if all(len(values) == 0 for values in delta.values()):
        return "=== Git Diff Before/After ===\n无文件变更\n=============================="
    lines = ["=== Git Diff Before/After ==="]
    if command:
        lines.append(f"Command: {command}")
    if delta["added"]:
        lines.append("Added:")
        lines.extend(f"  {item}" for item in delta["added"])
    if delta["modified"]:
        lines.append("Modified:")
        lines.extend(f"  {item}" for item in delta["modified"])
    if delta["deleted"]:
        lines.append("Deleted:")
        lines.extend(f"  {item}" for item in delta["deleted"])
    lines.append("==============================")
    return "\n".join(lines)


async def collect_git_overview(cwd: Path) -> Tuple[Optional[list[tuple[str, str]]], Optional[str]]:
    status = await get_git_status_rows(cwd)
    diff_stat = await get_git_diff_stat(cwd)
    return status, diff_stat
