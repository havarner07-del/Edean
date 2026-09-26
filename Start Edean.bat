@echo off
rem Double-click to run Edean from source (needs Node.js 22+ from https://nodejs.org).
cd /d "%~dp0"
where node >nul 2>nul || (echo Node.js is not installed. Get it from https://nodejs.org & pause & exit /b 1)
if not exist node_modules (echo Installing Edean's libraries... & call npm install --omit=dev || (pause & exit /b 1))
node launcher.js
pause
