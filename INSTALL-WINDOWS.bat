@echo off
setlocal
cd /d "%~dp0"

title Yandex Smart Home [n-bord] - Windows installer

echo.
echo ============================================================
echo   Yandex Smart Home [n-bord] v1.1.0
echo   Stream Dock plugin installer for Windows
echo ============================================================
echo.

if not exist "%~dp0installer\_install.ps1" (
    echo ERROR: installer\_install.ps1 was not found.
    echo Please extract the entire ZIP archive before installation.
    echo.
    pause
    exit /b 2
)

powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0installer\_install.ps1"
set "EXITCODE=%ERRORLEVEL%"

echo.
if not "%EXITCODE%"=="0" (
    echo Installer returned exit code %EXITCODE%.
    echo See install-windows.log in this folder for details.
    echo.
)

pause
exit /b %EXITCODE%
