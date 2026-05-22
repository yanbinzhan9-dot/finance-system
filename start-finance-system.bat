@echo off
cd /d "%~dp0"
start "Finance System Server" /min python server.py
timeout /t 1 /nobreak >nul
start "" "http://127.0.0.1:8765/index.html"
