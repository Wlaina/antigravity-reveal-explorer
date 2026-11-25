@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo ============================================================
echo   Antigravity 右键「在资源管理器中显示」插件 一键更新并重装
echo ============================================================
echo.
if exist ".git" (
  where git >nul 2>&1
  if not errorlevel 1 (
    echo 正在从 GitHub 拉取最新代码...
    git pull --ff-only
    if errorlevel 1 (
      echo.
      echo [!] git pull 失败，请先检查本地修改或网络连接。
      pause
      exit /b 1
    )
    echo.
  )
)
echo 正在同步最新插件并重新应用 ASAR 补丁...
node setup.cjs --kill --relaunch
if errorlevel 1 (
  echo.
  echo [!] 更新安装遇到问题，请确认已安装 Node.js 18+ 且 Antigravity 已完全退出。
  pause
  exit /b 1
)
echo.
echo [√] 更新并重装完成！Antigravity 已重新启动。
timeout /t 3 >nul
