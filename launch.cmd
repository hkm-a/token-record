@echo off
rem 双击启动 Token 记录悬浮窗（绿色启动，无需安装）。
rem 直接调用本项目内已就绪的 Electron 运行时加载应用。
cd /d "%~dp0"
start "" "%~dp0node_modules\electron\dist\electron.exe" "%~dp0."
