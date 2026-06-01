@echo off
cd /d "%~dp0..\.."

:: Clear ELECTRON_RUN_AS_NODE so Electron launches properly as a GUI app
set ELECTRON_RUN_AS_NODE=

echo Checking dependencies...
if not exist "node_modules\electron" (
    echo Installing workspace packages, one moment...
    call npm ci
)

echo Launching Eris IDE...
call npm run start --workspace=@defnotean/eris-agent
