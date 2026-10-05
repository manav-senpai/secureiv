@echo off
title SECURE-IV Clinical Platform Launcher
echo =================================================================
echo   SECURE-IV Master Clinical IV Platform (Mahiru 🐰✨)
echo =================================================================
echo.
echo Launching Google Chrome...
start "" http://localhost:8080/index.html
python -m http.server 8080 --directory "%~dp0"
pause
