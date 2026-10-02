"""Shared subprocess runner: turns tool failures into errors carrying real stderr."""

import os
import subprocess

STDERR_TAIL = 4000


class ToolError(Exception):
    def __init__(self, message: str, stderr: str = ""):
        super().__init__(message)
        self.message = message
        self.stderr = stderr


def run(cmd: list[str], what: str, cwd=None) -> subprocess.CompletedProcess:
    env = {**os.environ, "PYTHONIOENCODING": "utf-8"}
    try:
        proc = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            cwd=cwd,
            env=env,
        )
    except FileNotFoundError:
        raise ToolError(f"{what}: executable not found ({cmd[0]}). Is it installed and on PATH?")
    if proc.returncode != 0:
        raise ToolError(f"{what} failed (exit code {proc.returncode})", proc.stderr[-STDERR_TAIL:])
    return proc
