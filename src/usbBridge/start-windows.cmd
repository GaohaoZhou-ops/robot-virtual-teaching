@echo off
chcp 65001 >nul
cd /d "%~dp0"
where py >nul 2>nul
if not errorlevel 1 (
  py -3 ipadUSBBridge.py
  pause
  exit /b
)
where python >nul 2>nul
if not errorlevel 1 (
  python ipadUSBBridge.py
  pause
  exit /b
)
echo Please install Python 3.9 or newer from https://www.python.org/downloads/windows/
echo Then run this file again. See README.txt for Apple device setup.
pause
