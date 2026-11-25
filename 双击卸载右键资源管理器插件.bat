@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo ============================================================
echo   Antigravity 右键「在资源管理器中显示」插件 一键安全卸载程序
echo ============================================================
echo.
echo 正在移除右键资源管理器补丁并恢复客户端文件...
node setup.cjs --uninstall --kill --relaunch
if errorlevel 1 (
  echo.
  echo [!] 卸载遇到问题，请手动关闭 Antigravity 后重试。
  pause
  exit /b 1
)
echo.
echo [√] 已安全卸载并重启 Antigravity！
timeout /t 3 >nul
