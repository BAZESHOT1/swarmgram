@echo off
cd /d "%~dp0"
if not exist node_modules (
  echo Installing serialport...
  call npm install --no-audit --no-fund
)
where python >nul 2>nul
if errorlevel 1 (
  if exist "%LOCALAPPDATA%\Programs\Python\Python312\python.exe" (
    set KINTO_PYTHON=%LOCALAPPDATA%\Programs\Python\Python312\python.exe
  )
)
node server.mjs --port=8787
