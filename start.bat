@echo off
setlocal EnableExtensions
title shortsforge
cd /d "%~dp0"

if not defined PORT set "PORT=8765"
if not defined HOST set "HOST=127.0.0.1"

echo.
echo  ==================================================
echo    shortsforge  -  turn YouTube videos into Shorts
echo  ==================================================
echo.

rem Make tools installed moments ago visible without a restart or sign-out:
rem portable ffmpeg in .tools, uv's own installer, and winget's install locations.
set "PATH=%CD%\.tools\ffmpeg\bin;%USERPROFILE%\.local\bin;%LOCALAPPDATA%\Microsoft\WinGet\Links;%PATH%"
call :add_winget_ffmpeg

call :is_running && (
  echo  shortsforge is already running - opening it in your browser.
  if not defined SHORTSFORGE_NO_BROWSER start "" "http://localhost:%PORT%"
  ping -n 3 127.0.0.1 >nul
  exit /b 0
)

echo  [1/3] Checking uv ...
call :ensure_uv || goto :fail
echo  [2/3] Checking ffmpeg ...
call :ensure_ffmpeg || goto :fail
echo  [3/3] Setting up the app - the first run downloads Python and packages, this takes a few minutes ...
uv sync --frozen --quiet || (
  echo  [x] Installing the app's packages failed - see the message above.
  goto :fail
)

echo.
echo  --------------------------------------------------
echo    shortsforge is running:  http://localhost:%PORT%
echo    Your browser will open by itself.
echo.
echo    KEEP THIS WINDOW OPEN while you use the app.
echo    Close it when you are done to stop shortsforge.
echo  --------------------------------------------------
echo.

rem Open the browser as soon as the server answers.
if not defined SHORTSFORGE_NO_BROWSER start "" /b powershell -NoProfile -WindowStyle Hidden -Command "for ($i = 0; $i -lt 240; $i++) { try { Invoke-RestMethod -TimeoutSec 2 http://127.0.0.1:%PORT%/api/health | Out-Null; Start-Process 'http://localhost:%PORT%'; break } catch { Start-Sleep -Milliseconds 500 } }"

uv run --frozen uvicorn backend.main:app --host %HOST% --port %PORT% --log-level warning
echo.
echo  shortsforge stopped.
echo  If you saw "address already in use", another program is using port %PORT%.
echo  Close it, or run:  set PORT=9000  and then start.bat
pause
exit /b 0


rem ---------------------------------------------------------------- helpers

:ensure_uv
where uv >nul 2>nul && exit /b 0
echo       uv is missing. It runs shortsforge and installs Python for it automatically.
call :ask "      Install uv now?" || exit /b 1
where winget >nul 2>nul && winget install -e --id astral-sh.uv --accept-source-agreements --accept-package-agreements
where uv >nul 2>nul && exit /b 0
echo       Trying uv's official installer ...
powershell -NoProfile -ExecutionPolicy Bypass -Command "irm https://astral.sh/uv/install.ps1 | iex"
where uv >nul 2>nul && exit /b 0
echo  [x] uv could not be installed automatically.
echo      Install it from https://docs.astral.sh/uv/ and double-click start.bat again.
exit /b 1

:ensure_ffmpeg
call :have_ffmpeg && exit /b 0
echo       ffmpeg is missing. It cuts and renders the videos.
call :ask "      Install ffmpeg now?" || exit /b 1
where winget >nul 2>nul && winget install -e --id Gyan.FFmpeg --accept-source-agreements --accept-package-agreements
call :add_winget_ffmpeg
call :have_ffmpeg && exit /b 0
echo       Downloading a portable ffmpeg into this folder instead ...
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\get-ffmpeg.ps1"
call :have_ffmpeg && exit /b 0
echo  [x] ffmpeg could not be installed automatically.
echo      Install it from https://www.gyan.dev/ffmpeg/builds/ and double-click start.bat again.
exit /b 1

:have_ffmpeg
where ffmpeg >nul 2>nul || exit /b 1
where ffprobe >nul 2>nul || exit /b 1
exit /b 0

:add_winget_ffmpeg
rem winget's ffmpeg package lives in a versioned folder; add its bin to PATH for this window.
for /d %%D in ("%LOCALAPPDATA%\Microsoft\WinGet\Packages\Gyan.FFmpeg*") do for /d %%E in ("%%D\ffmpeg-*") do if exist "%%E\bin\ffmpeg.exe" set "PATH=%%E\bin;%PATH%"
exit /b 0

:is_running
powershell -NoProfile -Command "try { if ((Invoke-RestMethod -TimeoutSec 2 http://127.0.0.1:%PORT%/api/health).ok) { exit 0 } } catch {}; exit 1" >nul 2>nul
exit /b %errorlevel%

:ask
if defined SHORTSFORGE_YES exit /b 0
choice /c YN /n /m "%~1 [Y/N] "
if errorlevel 2 exit /b 1
exit /b 0

:fail
echo.
echo  Setup did not finish. Fix the problem above, then double-click start.bat again.
echo.
pause
exit /b 1
