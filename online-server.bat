@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo 已合并到统一 Node 服务，请使用 start-all.bat
call "%~dp0start-all.bat"
