@echo off
cd /d "%~dp0agent-ui"

:: Clear ELECTRON_RUN_AS_NODE so Electron launches properly as a GUI app
set ELECTRON_RUN_AS_NODE=

echo Checking dependencies...
if not exist "node_modules\electron" (
    echo Installing packages, one moment...
    call npm install
)

echo Launching Eris IDE...
node_modules\electron\dist\electron.exe .
