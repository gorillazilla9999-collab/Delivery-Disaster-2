@echo off
cd /d "%~dp0"
if not exist node_modules call npm install
echo Delivery Disaster running at http://localhost:3000  (close this window to stop)
start "" http://localhost:3000
call npm start
