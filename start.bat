@echo off
title Hope Studio - keep open while streaming
cd /d "%~dp0"
if not exist node_modules call npm install
node server.js
pause
