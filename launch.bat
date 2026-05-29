@echo off
REM ─── monobot launcher (Windows wrapper) ──────────────────────────────────
REM   Double-click to SSH into the Linux box and run launch.sh.
REM   Closing this window or pressing Ctrl-C inside it kills both bots and
REM   restores systemd 24/7 mode (the cleanup is done by launch.sh itself).
REM
REM Prerequisites:
REM   1. Windows 10/11 has OpenSSH built in (`ssh` on PATH).
REM   2. Either passwordless key auth set up, or you OK with typing the
REM      Linux user's password each time.
REM   3. Edit LINUX_HOST below if your IP changes.

setlocal

set "LINUX_USER=defnotean"
set "LINUX_HOST=192.168.1.117"
set "REMOTE_SCRIPT=/home/defnotean/Desktop/monobot/launch.sh"

title monobot launcher — %LINUX_USER%@%LINUX_HOST%

echo.
echo  ╔════════════════════════════════════════════════════╗
echo  ║         monobot launcher (remote via SSH)          ║
echo  ╚════════════════════════════════════════════════════╝
echo.
echo  Target: %LINUX_USER%@%LINUX_HOST%
echo  Script: %REMOTE_SCRIPT%
echo.
echo  Press Ctrl-C (or close this window) to stop the bots
echo  and restore systemd 24/7 mode.
echo.

REM -t forces a pseudo-TTY so Ctrl-C reaches the remote bash
REM -o ServerAliveInterval keeps the link alive on idle connections
ssh -t -o ServerAliveInterval=30 ^
    %LINUX_USER%@%LINUX_HOST% ^
    "bash %REMOTE_SCRIPT%"

echo.
echo  SSH session ended. systemd has resumed.
echo.
pause
endlocal
