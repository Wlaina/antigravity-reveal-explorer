---
name: ag-reveal-in-explorer
description: 检查、维护或重新部署 Antigravity 右键「在资源管理器中显示」与「复制文件路径」插件（ag-reveal-in-explorer），并排查右键菜单、路径解析或客户端更新后的 ASAR 补丁状态。
---

# `ag-reveal-in-explorer` 使用与维护指南

本插件（仓库：`https://github.com/Wlaina/antigravity-reveal-explorer`）为 Windows（同时兼容 macOS/Linux）上的 **Google Antigravity 2.0** 客户端提供与 Claude Desktop 一致的右键文件菜单体验：在聊天内容、代码块、文件引用链接或文件卡片上右键，可直接触发一级 **复制文件路径** 与 **在资源管理器中显示**，以及 **作为上下文附加**、**复制更多（文件名 / 相对路径 / `file://` 链接）**、**打开方式（默认应用 / 打开文件夹 / 在终端中打开）**。

## 检查插件与补丁状态

当用户询问插件是否生效、怀疑客户端更新冲掉了补丁，或排查右键菜单问题时，在插件目录下运行：

```bash
node setup.cjs --check
```

插件安装目录通常为 `~/.gemini/config/plugins/ag-reveal-in-explorer/`（Windows 下即 `%USERPROFILE%\.gemini\config\plugins\ag-reveal-in-explorer\`）。

状态 JSON 中的关键字段含义：

- `pluginInstalled` / `skillInstalled`：插件清单与 Skill 文件是否已部署。
- `asarStatus.revealMainPatched` / `asarStatus.revealPreloadPatched`：客户端 `resources/app.asar` 是否已激活主进程与渲染层注入块。
- `asarStatus.stagedReady` / `asarStatus.stagedValid`：是否存在待应用的已校验暂存包 `app.asar.reveal-staged`。

## 从 GitHub 更新与重新打补丁

Antigravity 官方版本更新会覆盖 `resources/app.asar`。如需在不中断当前对话的情况下生成新版本暂存包，可先运行：

```bash
node setup.cjs
```

不要在运行中的 Antigravity 对话里传递 `--kill` 参数。生成暂存包后，请提示用户退出 Antigravity 并双击 `双击安装右键资源管理器插件.bat`（或直接双击 `一键更新并重装插件.bat` 从 GitHub 拉取最新版并重启激活）。

## 安全卸载

如需移除本插件及其 ASAR 注入块并恢复客户端文件，可引导用户双击 `双击卸载右键资源管理器插件.bat`，或在关闭客户端后执行：

```bash
node setup.cjs --uninstall
```
