@echo off
chcp 65001 >nul
title QuantPick 智能选股终端(真实数据服务 · 端口 8090)
cd /d "%~dp0"

echo ============================================
echo   QuantPick 智能选股终端
echo   数据源:东方财富 + 腾讯公开接口(准实时)
echo   访问: http://127.0.0.1:8090
echo   关闭本窗口即停止服务
echo ============================================
echo.

rem 若端口已在监听,说明服务已在运行,直接打开浏览器即可
netstat -ano | findstr ":8090.*LISTENING" >nul 2>&1
if %errorlevel%==0 (
  echo [提示] 检测到 8090 端口已有服务在运行,直接打开浏览器。
  start "" http://127.0.0.1:8090
  timeout /t 3 /nobreak >nul
  exit /b 0
)

node --version >nul 2>&1
if not %errorlevel%==0 (
  echo [错误] 未检测到 Node.js,请先安装 Node.js 后重试。
  echo        下载: https://nodejs.org
  pause
  exit /b 1
)

rem 延迟 3 秒再打开浏览器:等数据服务就绪(避免打开时页面报"数据服务不可用")
start "" cmd /c "timeout /t 3 /nobreak >nul & start "" http://127.0.0.1:8090"

echo [信息] 正在启动数据服务…
echo        浏览器将在约 3 秒后自动打开;若未打开,请手动访问 http://127.0.0.1:8090
echo.
node server.js

echo.
echo [信息] 服务已停止。
pause
