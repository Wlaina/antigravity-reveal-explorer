# ag-reveal-in-explorer · Antigravity 右键在资源管理器中显示

[![version](https://img.shields.io/badge/version-v1.1.1-6366f1.svg)](https://github.com/Wlaina/antigravity-reveal-explorer/releases)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)

为 **Google Antigravity 2.0**（已实测适配 `2.35.2`）提供与 **Claude Desktop** 一致的右键文件菜单体验：在对话消息里的文件链接（`file://`）、代码路径（`src/index.ts`、`C:\...`、`~/...`）、纯文件名（如 `report.pdf`、`rules.md`）或文件卡片上点击鼠标右键，即可直接弹出或追加以下操作：

- **作为上下文附加**：将路径快速填入底部对话输入框
- **复制文件路径**（v1.1.0 提升至一级菜单）：一键复制本地规范化完整路径
- **复制更多 >**：复制文件名、复制相对路径、复制 `file://` 链接、复制所选文本
- **打开方式 >**：系统默认应用、打开文件夹 / 打开所在文件夹、在终端中打开所在文件夹
- **在资源管理器中显示**（Windows 精确高亮选中目标文件；macOS 为「在访达中显示」，Linux 为「在文件管理器中显示」）

---

## ✨ 功能特性

- **三路无缝菜单集成**：
  1. 自动增强 Antigravity 原生 `window:show-context-menu` 右键菜单，按需补齐「复制文件路径」与「在资源管理器中显示」（若原菜单已包含对应项则绝不重复添加）。
  2. 对话中的 `file://` 链接、行内 `<code>` 路径、纯文件名与文件卡片直接弹出 Claude Desktop 风格原生菜单。
  3. 兼容页面内基于 DOM / Radix 的浮层菜单（同步追加一级「复制文件路径」与「在资源管理器中显示」）。
- **智能工作区路径解析**：自动结合 `~/.gemini/config/projects/*.json`、当前对话产物目录（`~/.gemini/antigravity/brain/<convId>/`）与当前页面已有链接目录，在限定深度与 60ms 时间预算内精确匹配相对路径与纯文件名。
- **无损独立注入**：通过独立标记块 `// ===== AG_REVEAL_EXPLORER_BEGIN =====` ~ `END` 写入 `dist/main.js` 与 `dist/preload.js`，自动校验 SHA-256 完整性并支持干净卸载，不影响客户端原有文件与其余内容。

---

## 📦 从 GitHub 安装与更新

### 第一步：下载源码

**方式 A — 使用 Git 克隆（推荐，方便后续一键更新）**：

```bash
git clone https://github.com/Wlaina/antigravity-reveal-explorer.git
cd antigravity-reveal-explorer
```

**方式 B — 直接下载 ZIP**：在 GitHub 仓库右上角点击 **Code → Download ZIP**，解压到本地文件夹即可。

### 第二步：安装与激活

#### Windows 一键双击安装（推荐）

直接双击运行目录中的：

```text
双击安装右键资源管理器插件.bat
```

脚本会自动结束占用 `app.asar` 的 Antigravity 进程、将插件同步到 `%USERPROFILE%\.gemini\config\plugins\ag-reveal-in-explorer\`、校验并写入补丁，随后自动重启 Antigravity。

#### 命令行安装

```bash
# 1. 部署插件文件并生成校验通过的暂存补丁包（不中断当前正在运行的 Antigravity）
node setup.cjs

# 2. 立即结束进程、应用补丁并重启 Antigravity（Windows）
node setup.cjs --kill --relaunch

# 若手动关闭了 Antigravity，可直接应用已暂存的补丁包：
node setup.cjs --apply-staged --relaunch
```

### 第三步：一键更新与状态检查

- **从 GitHub 一键更新并重装**：直接双击 [`一键更新并重装插件.bat`](./一键更新并重装插件.bat)（或执行 `git pull --ff-only && node setup.cjs --kill --relaunch`）。
- **状态检查**：

```bash
node setup.cjs --check
```

若 `asarStatus.revealMainPatched` 和 `asarStatus.revealPreloadPatched` 均为 `true`，表示补丁已激活；若 `stagedReady: true` 且 `stagedValid: true`，表示暂存补丁包已准备就绪，重启应用前执行一次 `双击安装右键资源管理器插件.bat` 即可生效。

---

## 🔄 客户端更新后恢复与安全卸载

- **Antigravity 更新后补丁失效**：客户端官方更新会覆盖 `resources/app.asar`，只需再次双击 `双击安装右键资源管理器插件.bat` 即可恢复。
- **安全卸载**：双击运行 `双击卸载右键资源管理器插件.bat`（或执行 `node setup.cjs --uninstall --kill --relaunch`），会自动剥离本插件注入块并恢复 `app.asar`。

---

## 📄 开源协议

本项目基于 [**MIT License**](./LICENSE) 开源。
