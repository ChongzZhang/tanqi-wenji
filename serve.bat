@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo 静态页面已由 Node 服务托管，请使用 start-all.bat
call "%~dp0start-all.bat"
