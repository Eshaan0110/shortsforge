@echo off
setlocal
title shortsforge
cd /d "%~dp0"

if "%PORT%"=="" set "PORT=8765"
if "%HOST%"=="" set "HOST=127.0.0.1"

where uv >nul 2>nul || (
  echo [x] uv is not installed. Install it, then open a NEW terminal and run start.bat again:
  echo       winget install astral-sh.uv
  pause & exit /b 1
)
where ffmpeg >nul 2>nul || (
  echo [x] ffmpeg is not installed. Install it, then open a NEW terminal and run start.bat again:
  echo       winget install Gyan.FFmpeg
  pause & exit /b 1
)
where ffprobe >nul 2>nul || (
  echo [x] ffprobe was not found ^(it ships with ffmpeg^). Reinstall ffmpeg: winget install Gyan.FFmpeg
  pause & exit /b 1
)

echo Checking dependencies (the first run downloads Python packages and takes a few minutes)...
uv sync --frozen --quiet || (
  echo [x] Installing dependencies failed - see the error above.
  pause & exit /b 1
)

echo.
echo   shortsforge is running at  http://localhost:%PORT%
echo   Close this window to stop it.
echo.
start "" cmd /c "timeout /t 4 /nobreak >nul & start http://localhost:%PORT%"
uv run --frozen uvicorn backend.main:app --host %HOST% --port %PORT%
echo.
echo shortsforge stopped. If you see "address already in use", another copy is running or set a different PORT.
pause
