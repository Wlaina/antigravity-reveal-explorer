@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo ============================================================
echo   Antigravity 右键「在资源管理器中显示」插件 一键安装程序
echo ============================================================
echo.
echo 正在部署插件文件、生成校验通过的 ASAR 补丁包并重启 Antigravity...
echo （会自动保留中文汉化补丁与猫娘观察台补丁）
echo.
node setup.cjs --kill --relaunch
if errorlevel 1 (
  echo.
  echo [!] 安装遇到问题，请确认已安装 Node.js 18+ 且 Antigravity 已完全退出。
  pause
  exit /b 1
)
echo.
echo [√] 安装完成！Antigravity 已重新启动，右键文件即可「在资源管理器中显示」！
timeout /t 3 >nul
