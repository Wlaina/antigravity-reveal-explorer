// ===== AG_REVEAL_EXPLORER_BEGIN =====
(function () {
  'use strict';

  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const url = require('url');
  const { spawn } = require('child_process');

  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const PROJECTS_DIR = path.join(os.homedir(), '.gemini', 'config', 'projects');
  const BRAIN_DIR = path.join(os.homedir(), '.gemini', 'antigravity', 'brain');
  const BFS_SKIP_DIRS = new Set([
    'node_modules',
    '.git',
    '.hg',
    '.svn',
    'dist',
    'build',
    'out',
    '.next',
    '.nuxt',
    '.venv',
    'venv',
    '__pycache__',
    'target',
    '.cache',
    '.turbo',
    'coverage'
  ]);

  let projectCache = {
    dirMtimeMs: -1,
    checkedAt: 0,
    projects: []
  };

  function safeDecodeURIComponent(str) {
    try {
      return decodeURIComponent(str);
    } catch {
      return str.replace(/%([0-9A-Fa-f]{2})/g, (m, hex) => {
        try {
          return decodeURIComponent('%' + hex);
        } catch {
          return m;
        }
      });
    }
  }

  /**
   * 将 file:// URI 稳健解析为本地文件系统路径。
   * 兼容 file:///d%3A/...、file://d:/...、#L10-L20、?query、中文编码与畸形 % 回退。
   * @param {string} rawUri
   * @returns {string}
   */
  function parseFileUriToLocalPath(rawUri) {
    if (typeof rawUri !== 'string') return '';
    let trimmed = rawUri.trim();
    if (!/^file:\/\//i.test(trimmed)) return '';

    // 去掉 hash 与 query，避免影响路径匹配与 fileURLToPath
    const hashIdx = trimmed.indexOf('#');
    if (hashIdx !== -1) trimmed = trimmed.slice(0, hashIdx);
    const queryIdx = trimmed.indexOf('?');
    if (queryIdx !== -1) trimmed = trimmed.slice(0, queryIdx);

    // 兼容 file://d:/... 这种缺少第三个斜杠的写法
    if (/^file:\/\/[A-Za-z]:/i.test(trimmed)) {
      trimmed = 'file:///' + trimmed.slice(7);
    }

    // 处理未转义的孤立 % 字符，先尝试原生 url.fileURLToPath
    const safeForNode = trimmed.replace(/%(?![0-9A-Fa-f]{2})/g, '%25');
    try {
      const converted = url.fileURLToPath(safeForNode);
      return process.platform === 'win32'
        ? path.win32.normalize(converted)
        : path.normalize(converted);
    } catch {
      // 回退解析
    }

    let body = trimmed.replace(/^file:\/\//i, '');
    if (body.startsWith('localhost/')) {
      body = body.slice('localhost'.length);
    }
    body = safeDecodeURIComponent(body);

    if (process.platform === 'win32') {
      if (/^\/[A-Za-z]:/.test(body)) {
        body = body.slice(1);
      } else if (/^[^/\\]+[/\\][A-Za-z]:/.test(body)) {
        body = body.replace(/^[^/\\]+[/\\]/, '');
      }
      if (/^[A-Za-z]:/.test(body)) {
        return path.win32.normalize(body.replace(/\//g, '\\'));
      }
      if (body.startsWith('//')) {
        return path.win32.normalize(body.replace(/\//g, '\\'));
      }
    }
    return path.normalize(body);
  }

  /**
   * 展开 ~/、~\ 及常见 Windows 环境变量路径。
   * @param {string} raw
   * @returns {string}
   */
  function expandUserAndEnvPath(raw) {
    if (typeof raw !== 'string') return '';
    let out = raw.trim();
    if (!out) return '';
    if (out === '~' || /^~[\\/]/.test(out)) {
      out = path.join(os.homedir(), out.slice(1));
    }
    if (process.platform === 'win32') {
      out = out.replace(/%([A-Za-z0-9_]+)%/g, (full, name) => {
        const key = Object.keys(process.env).find((k) => k.toUpperCase() === name.toUpperCase());
        return key && process.env[key] ? process.env[key] : full;
      });
    }
    return out;
  }

  function safeStat(targetPath) {
    if (!targetPath) return null;
    try {
      return fs.statSync(targetPath);
    } catch {
      return null;
    }
  }

  /**
   * 若原路径不存在，尝试剥离末尾 :line[:col]、#L10-L20、(10, 2) 等行号后缀后再探测。
   * @param {string} candidatePath
   * @returns {{absPath: string, stat: fs.Stats} | null}
   */
  function probeExistingPath(candidatePath) {
    if (!candidatePath) return null;
    const norm = process.platform === 'win32'
      ? path.win32.normalize(candidatePath)
      : path.normalize(candidatePath);
    let st = safeStat(norm);
    if (st) return { absPath: norm, stat: st };

    const strippedVariants = [
      candidatePath.replace(/#L\d+(?:C\d+)?(?:-L?\d+(?:C\d+)?)?$/i, ''),
      candidatePath.replace(/:\d+(?::\d+)?(?:-\d+(?::\d+)?)?$/, ''),
      candidatePath.replace(/\(\d+(?:,\s*\d+)?\)$/, '')
    ];
    for (const v of strippedVariants) {
      if (!v || v === candidatePath) continue;
      const vNorm = process.platform === 'win32' ? path.win32.normalize(v) : path.normalize(v);
      st = safeStat(vNorm);
      if (st) return { absPath: vNorm, stat: st };
    }
    return null;
  }

  /**
   * 向上查找存在的最近父目录（用于已删除的显式 file:// 链接）。
   * @param {string} targetPath
   * @returns {string}
   */
  function findExistingParent(targetPath) {
    if (!targetPath) return '';
    let cur = process.platform === 'win32'
      ? path.win32.normalize(targetPath)
      : path.normalize(targetPath);
    for (let i = 0; i < 12; i++) {
      const parent = path.dirname(cur);
      if (!parent || parent === cur) break;
      const st = safeStat(parent);
      if (st && st.isDirectory()) return parent;
      cur = parent;
    }
    return '';
  }

  function isAbsoluteLocalPath(p) {
    if (!p) return false;
    if (process.platform === 'win32') {
      return /^[A-Za-z]:[\\/]/.test(p) || /^\\\\[^\\]+\\[^\\]+/.test(p);
    }
    return p.startsWith('/');
  }

  function cleanCandidateRaw(raw) {
    if (typeof raw !== 'string') return '';
    let s = raw.trim();
    if (!s || s.length > 520 || /[\r\n]/.test(s)) return '';
    // 剥离成对包裹整个字符串的外围括号或引号
    s = s.replace(/^[`'"“”‘’<]+/, '').replace(/[`'"“”‘’>.,;，。；：:!?！？]+$/, '').trim();
    if ((s.startsWith('(') && s.endsWith(')')) || (s.startsWith('[') && s.endsWith(']')) || (s.startsWith('（') && s.endsWith('）'))) {
      s = s.slice(1, -1).trim();
    }
    return s;
  }

  function loadProjectsCached() {
    const now = Date.now();
    const dirSt = safeStat(PROJECTS_DIR);
    if (!dirSt || !dirSt.isDirectory()) return [];
    if (dirSt.mtimeMs === projectCache.dirMtimeMs && now - projectCache.checkedAt < 5000) {
      return projectCache.projects;
    }

    const projects = [];
    try {
      const entries = fs.readdirSync(PROJECTS_DIR);
      for (const name of entries) {
        if (!name.endsWith('.json')) continue;
        const fp = path.join(PROJECTS_DIR, name);
        try {
          const data = JSON.parse(fs.readFileSync(fp, 'utf8'));
          const resources = data && data.projectResources && Array.isArray(data.projectResources.resources)
            ? data.projectResources.resources
            : [];
          const roots = [];
          for (const res of resources) {
            const uri = res && res.folderUri;
            if (!uri || !/^file:\/\//i.test(uri)) continue;
            const localDir = parseFileUriToLocalPath(uri);
            const st = safeStat(localDir);
            if (st && st.isDirectory()) {
              roots.push(localDir);
            }
          }
          if (roots.length > 0) {
            projects.push({
              id: typeof data.id === 'string' ? data.id : name.replace(/\.json$/i, ''),
              name: typeof data.name === 'string' ? data.name.trim() : '',
              roots
            });
          }
        } catch {
          // 忽略损坏的单个项目配置
        }
      }
    } catch {
      return projectCache.projects;
    }

    projectCache = {
      dirMtimeMs: dirSt.mtimeMs,
      checkedAt: now,
      projects
    };
    return projects;
  }

  function dedupeDirs(list) {
    const seen = new Set();
    const out = [];
    for (const dir of list) {
      if (!dir) continue;
      const norm = process.platform === 'win32' ? path.win32.normalize(dir) : path.normalize(dir);
      const key = process.platform === 'win32' ? norm.toLowerCase() : norm;
      if (seen.has(key)) continue;
      const st = safeStat(norm);
      if (!st || !st.isDirectory()) continue;
      seen.add(key);
      out.push(norm);
    }
    return out;
  }

  /**
   * 汇总当前上下文可用的工作区目录与产物目录，并将命中当前项目名称的根目录置顶。
   * @param {string} convId
   * @param {string} projectHint
   * @param {string[]} pageFileHints
   * @param {string[]} extraRoots
   */
  function loadWorkspaceRoots(convId, projectHint, pageFileHints, extraRoots) {
    const projects = loadProjectsCached();
    const hintNorm = typeof projectHint === 'string' ? projectHint.trim().toLowerCase() : '';
    const priorityRoots = [];
    const otherRoots = [];

    if (Array.isArray(extraRoots)) {
      for (const r of extraRoots) priorityRoots.push(r);
    }

    // 根据页面上已有的 file:// 链接推断当前工作区或所在目录
    const hintDirs = [];
    if (Array.isArray(pageFileHints)) {
      for (const rawHint of pageFileHints.slice(0, 12)) {
        const fp = /^file:\/\//i.test(String(rawHint || ''))
          ? parseFileUriToLocalPath(String(rawHint))
          : expandUserAndEnvPath(String(rawHint || ''));
        if (!fp) continue;
        let cur = safeStat(fp)?.isDirectory() ? fp : path.dirname(fp);
        for (let depth = 0; depth < 3 && cur; depth++) {
          hintDirs.push(cur);
          const parent = path.dirname(cur);
          if (!parent || parent === cur) break;
          cur = parent;
        }
      }
    }

    for (const proj of projects) {
      const pName = (proj.name || '').toLowerCase();
      const matchedName = Boolean(hintNorm && pName && (pName === hintNorm || hintNorm.includes(pName) || pName.includes(hintNorm)));
      const matchedHintDir = proj.roots.some((root) => {
        const rKey = process.platform === 'win32' ? root.toLowerCase() : root;
        return hintDirs.some((hd) => {
          const hKey = process.platform === 'win32' ? hd.toLowerCase() : hd;
          return hKey === rKey || hKey.startsWith(rKey + path.sep);
        });
      });
      if (matchedName || matchedHintDir) {
        priorityRoots.push(...proj.roots);
      } else {
        otherRoots.push(...proj.roots);
      }
    }

    const artifactRoots = [];
    const cleanConv = typeof convId === 'string' ? convId.trim().toLowerCase() : '';
    if (UUID_RE.test(cleanConv)) {
      const base = path.join(BRAIN_DIR, cleanConv);
      artifactRoots.push(base, path.join(base, 'scratch'), path.join(base, '.user_uploaded'));
    }

    return {
      priorityRoots: dedupeDirs(priorityRoots),
      artifactRoots: dedupeDirs(artifactRoots),
      hintRoots: dedupeDirs(hintDirs),
      otherRoots: dedupeDirs(otherRoots),
      allWorkspaces: dedupeDirs([...priorityRoots, ...otherRoots])
    };
  }

  /**
   * 在限定深度、目录数与时间预算内做有界 BFS 查找纯文件名。
   */
  function findFilenameBoundedBfs(roots, filename, opts = {}) {
    const maxDepth = Number.isFinite(opts.maxDepth) ? opts.maxDepth : 4;
    const maxDirs = Number.isFinite(opts.maxDirs) ? opts.maxDirs : 600;
    const budgetMs = Number.isFinite(opts.budgetMs) ? opts.budgetMs : 60;
    const deadline = Date.now() + budgetMs;
    const isWin = process.platform === 'win32';
    const targetLower = filename.toLowerCase();

    const queue = [];
    const visited = new Set();
    for (const root of roots) {
      queue.push({ dir: root, depth: 0 });
    }

    let scannedDirs = 0;
    while (queue.length > 0 && scannedDirs < maxDirs && Date.now() < deadline) {
      const { dir, depth } = queue.shift();
      const key = isWin ? dir.toLowerCase() : dir;
      if (visited.has(key)) continue;
      visited.add(key);
      scannedDirs += 1;

      let entries;
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        continue;
      }

      // 先同层找精确/大小写不敏感匹配
      for (const ent of entries) {
        if (ent.name === filename || (isWin && ent.name.toLowerCase() === targetLower)) {
          const full = path.join(dir, ent.name);
          const st = safeStat(full);
          if (st) return { absPath: full, stat: st };
        }
      }

      if (depth < maxDepth) {
        for (const ent of entries) {
          if (!ent.isDirectory()) continue;
          if (BFS_SKIP_DIRS.has(ent.name) || ent.name.startsWith('.')) continue;
          queue.push({ dir: path.join(dir, ent.name), depth: depth + 1 });
        }
      }
    }
    return null;
  }

  function computeRelativePath(absPath, workspaces) {
    if (!absPath || !Array.isArray(workspaces)) return '';
    const isWin = process.platform === 'win32';
    const absKey = isWin ? absPath.toLowerCase() : absPath;
    for (const ws of workspaces) {
      const wsKey = isWin ? ws.toLowerCase() : ws;
      if (absKey === wsKey) return path.basename(absPath);
      const prefix = wsKey.endsWith(path.sep) ? wsKey : wsKey + path.sep;
      if (absKey.startsWith(prefix)) {
        return path.relative(ws, absPath);
      }
    }
    return '';
  }

  function toFileUriSafe(absPath) {
    try {
      return url.pathToFileURL(absPath).href;
    } catch {
      return '';
    }
  }

  function looksLikeNoiseIdentifier(text) {
    if (!text) return true;
    if (/^(https?|mailto|tel|javascript|data|blob|sidecar|customization|plugin|chrome|about|edge):/i.test(text)) {
      return true;
    }
    // 排除纯小数/版本号，例如 1.0.0、3.14
    if (/^\d+(?:\.\d+)+$/.test(text)) return true;
    // 仅排除无路径分隔符、形如 foo.bar() 的代码函数调用，避免误伤 "my notes (1).md"
    if (!/[\\/]/.test(text) && !/^[A-Za-z]:/.test(text) && /^[A-Za-z_$][\w$.]*\([^)]*\)$/.test(text)) {
      return true;
    }
    return false;
  }

  /**
   * 从渲染层传入的候选数组中解析出最终可定位的文件/目录目标。
   * @param {object} payload
   */
  function resolveCandidates(payload = {}) {
    const rawCandidates = Array.isArray(payload.candidates) ? payload.candidates : [];
    const selectedText = typeof payload.selectedText === 'string' ? payload.selectedText.trim().slice(0, 500) : '';
    const roots = loadWorkspaceRoots(
      payload.convId || '',
      payload.projectHint || '',
      payload.pageFileHints || [],
      payload.extraRoots || []
    );

    const orderedRoots = dedupeDirs([
      ...roots.priorityRoots,
      ...roots.artifactRoots,
      ...roots.hintRoots,
      ...roots.otherRoots
    ]);

    const seenCandidates = new Set();
    for (const item of rawCandidates) {
      const kind = (item && item.kind) || 'text';
      const rawVal = item && typeof item.value === 'string' ? item.value.trim() : '';
      if (!rawVal) continue;

      // 1. 显式 file:// URI（允许文件已被删除时打开其父目录）
      if (/^file:\/\//i.test(rawVal)) {
        const decoded = parseFileUriToLocalPath(rawVal);
        if (!decoded) continue;
        const hit = probeExistingPath(decoded);
        if (hit) {
          const isDir = hit.stat.isDirectory();
          return {
            canReveal: true,
            exists: true,
            isDir,
            absPath: hit.absPath,
            dirPath: isDir ? hit.absPath : path.dirname(hit.absPath),
            name: path.basename(hit.absPath),
            relativePath: computeRelativePath(hit.absPath, roots.allWorkspaces),
            fileUri: toFileUriSafe(hit.absPath),
            existingParent: isDir ? hit.absPath : path.dirname(hit.absPath),
            matchedKind: kind,
            selectedText
          };
        }
        const cleanMissing = decoded.replace(/#L\d+(?:C\d+)?(?:-L?\d+(?:C\d+)?)?$/i, '');
        const existingParent = findExistingParent(cleanMissing);
        if (existingParent) {
          return {
            canReveal: true,
            exists: false,
            isDir: false,
            absPath: cleanMissing,
            dirPath: existingParent,
            name: path.basename(cleanMissing),
            relativePath: computeRelativePath(cleanMissing, roots.allWorkspaces),
            fileUri: toFileUriSafe(cleanMissing),
            existingParent,
            matchedKind: kind,
            selectedText
          };
        }
        continue;
      }

      const cleaned = cleanCandidateRaw(rawVal);
      if (!cleaned || looksLikeNoiseIdentifier(cleaned)) continue;
      if (seenCandidates.has(cleaned)) continue;
      seenCandidates.add(cleaned);

      const expanded = expandUserAndEnvPath(cleaned);

      // 2. 绝对路径或 ~ 展开路径（必须真实存在）
      if (isAbsoluteLocalPath(expanded)) {
        const hit = probeExistingPath(expanded);
        if (hit) {
          const isDir = hit.stat.isDirectory();
          return {
            canReveal: true,
            exists: true,
            isDir,
            absPath: hit.absPath,
            dirPath: isDir ? hit.absPath : path.dirname(hit.absPath),
            name: path.basename(hit.absPath),
            relativePath: computeRelativePath(hit.absPath, roots.allWorkspaces),
            fileUri: toFileUriSafe(hit.absPath),
            existingParent: isDir ? hit.absPath : path.dirname(hit.absPath),
            matchedKind: kind,
            selectedText
          };
        }
        continue;
      }

      // 3. 相对路径（含 / 或 \）
      if (/[\\/]/.test(cleaned)) {
        const relClean = cleaned.replace(/^(?:\.[\\/])+/, '').replace(/^[/\\]+/, '');
        if (!relClean) continue;
        for (const root of orderedRoots) {
          const joined = path.join(root, relClean);
          const hit = probeExistingPath(joined);
          if (hit) {
            const isDir = hit.stat.isDirectory();
            return {
              canReveal: true,
              exists: true,
              isDir,
              absPath: hit.absPath,
              dirPath: isDir ? hit.absPath : path.dirname(hit.absPath),
              name: path.basename(hit.absPath),
              relativePath: computeRelativePath(hit.absPath, roots.allWorkspaces),
              fileUri: toFileUriSafe(hit.absPath),
              existingParent: isDir ? hit.absPath : path.dirname(hit.absPath),
              matchedKind: kind,
              selectedText
            };
          }
        }
        continue;
      }

      // 4. 纯文件名（如 女之旅.epub、rules.md、Dockerfile）
      const strippedFile = cleaned
        .replace(/#L\d+(?:C\d+)?(?:-L?\d+(?:C\d+)?)?$/i, '')
        .replace(/:\d+(?::\d+)?$/, '');
      const hasExt = /^[A-Za-z0-9_\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af .\-()]+\.[A-Za-z0-9]{1,10}$/.test(strippedFile);
      const isSpecialName = /^(Dockerfile|Makefile|README|LICENSE|CHANGELOG|GEMINI\.md|AGENTS\.md|\.gitignore|\.env)$/i.test(strippedFile);
      if (!hasExt && !isSpecialName) continue;

      // 先直查所有根与提示目录的直属子项
      let directHit = null;
      for (const root of orderedRoots) {
        directHit = probeExistingPath(path.join(root, strippedFile));
        if (directHit) break;
      }
      if (!directHit) {
        const bfsRoots = dedupeDirs([...roots.priorityRoots, ...roots.artifactRoots, ...roots.hintRoots]);
        if (bfsRoots.length > 0) {
          directHit = findFilenameBoundedBfs(bfsRoots, strippedFile, { maxDepth: 4, maxDirs: 600, budgetMs: 60 });
        }
      }
      if (!directHit && roots.otherRoots.length > 0) {
        directHit = findFilenameBoundedBfs(roots.otherRoots, strippedFile, { maxDepth: 2, maxDirs: 250, budgetMs: 40 });
      }
      if (directHit) {
        const isDir = directHit.stat.isDirectory();
        return {
          canReveal: true,
          exists: true,
          isDir,
          absPath: directHit.absPath,
          dirPath: isDir ? directHit.absPath : path.dirname(directHit.absPath),
          name: path.basename(directHit.absPath),
          relativePath: computeRelativePath(directHit.absPath, roots.allWorkspaces),
          fileUri: toFileUriSafe(directHit.absPath),
          existingParent: isDir ? directHit.absPath : path.dirname(directHit.absPath),
          matchedKind: kind,
          selectedText
        };
      }
    }

    return {
      canReveal: false,
      exists: false,
      selectedText
    };
  }

  function revealLabel() {
    if (process.platform === 'darwin') return '在访达中显示';
    if (process.platform === 'win32') return '在资源管理器中显示';
    return '在文件管理器中显示';
  }

  function spawnDetachedTerminal(targetDir) {
    const dir = targetDir && safeStat(targetDir)?.isDirectory() ? targetDir : os.homedir();
    if (process.platform === 'win32') {
      const winDir = path.win32.normalize(dir);
      try {
        const wt = spawn('wt.exe', ['-d', winDir], {
          detached: true,
          stdio: 'ignore',
          windowsHide: true
        });
        wt.on('error', () => {
          try {
            const ps = spawn('cmd.exe', ['/c', 'start', '""', 'powershell.exe', '-NoExit'], {
              cwd: winDir,
              detached: true,
              stdio: 'ignore',
              windowsHide: true
            });
            ps.unref();
          } catch {}
        });
        wt.unref();
        return;
      } catch {
        const ps = spawn('cmd.exe', ['/c', 'start', '""', 'powershell.exe', '-NoExit'], {
          cwd: winDir,
          detached: true,
          stdio: 'ignore',
          windowsHide: true
        });
        ps.unref();
        return;
      }
    }
    if (process.platform === 'darwin') {
      const child = spawn('open', ['-a', 'Terminal', dir], { detached: true, stdio: 'ignore' });
      child.unref();
      return;
    }
    const candidates = [
      ['x-terminal-emulator', []],
      ['gnome-terminal', ['--working-directory', dir]],
      ['konsole', ['--workdir', dir]]
    ];
    for (const [cmd, args] of candidates) {
      try {
        const child = spawn(cmd, args, { cwd: dir, detached: true, stdio: 'ignore' });
        child.unref();
        return;
      } catch {}
    }
  }

  if (process.env.AG_REVEAL_EXPORT_HELPERS === '1') {
    globalThis.__AG_REVEAL_HELPERS__ = {
      parseFileUriToLocalPath,
      expandUserAndEnvPath,
      probeExistingPath,
      findExistingParent,
      loadWorkspaceRoots,
      findFilenameBoundedBfs,
      resolveCandidates,
      computeRelativePath,
      revealLabel
    };
  }

  const skipElectronInit =
    process.env.AG_REVEAL_EXPORT_HELPERS === '1' &&
    !(process.versions && process.versions.electron);

  if (!skipElectronInit) {
    try {
      const electron = require('electron');
    const ipcMain = electron && electron.ipcMain;
    const shell = electron && electron.shell;
    const clipboard = electron && electron.clipboard;
    const Menu = electron && electron.Menu;
    const BrowserWindow = electron && electron.BrowserWindow;

    if (!ipcMain || globalThis.__AG_REVEAL_MAIN__) return;
    globalThis.__AG_REVEAL_MAIN__ = true;

    async function executeAction(action, target) {
      if (!target || typeof target !== 'object') {
        return { ok: false, error: '无效的文件目标' };
      }
      const normAbs = target.absPath
        ? (process.platform === 'win32' ? path.win32.normalize(target.absPath) : path.normalize(target.absPath))
        : '';
      const normDir = target.dirPath
        ? (process.platform === 'win32' ? path.win32.normalize(target.dirPath) : path.normalize(target.dirPath))
        : (normAbs ? path.dirname(normAbs) : '');

      switch (action) {
        case 'show_in_folder': {
          if (target.exists && normAbs) {
            shell.showItemInFolder(normAbs);
            return { ok: true, toast: '' };
          }
          const fallbackDir = target.existingParent || normDir;
          if (fallbackDir && safeStat(fallbackDir)?.isDirectory()) {
            const errMsg = await shell.openPath(fallbackDir);
            if (errMsg) return { ok: false, error: errMsg };
            return { ok: true, toast: '目标文件已不存在，已打开所在文件夹' };
          }
          return { ok: false, error: '未找到目标文件或其所在目录' };
        }
        case 'open_default': {
          if (!target.exists || !normAbs) {
            return { ok: false, error: '目标文件不存在' };
          }
          const errMsg = await shell.openPath(normAbs);
          return errMsg ? { ok: false, error: errMsg } : { ok: true, toast: '' };
        }
        case 'open_folder': {
          const dir = target.isDir && target.exists ? normAbs : (target.existingParent || normDir);
          if (!dir) return { ok: false, error: '目录不存在' };
          const errMsg = await shell.openPath(dir);
          return errMsg ? { ok: false, error: errMsg } : { ok: true, toast: '' };
        }
        case 'open_terminal': {
          const dir = target.isDir && target.exists ? normAbs : (target.existingParent || normDir);
          spawnDetachedTerminal(dir);
          return { ok: true, toast: '' };
        }
        case 'copy_path': {
          clipboard.writeText(normAbs || target.selectedText || '');
          return { ok: true, toast: target.name ? `已复制文件路径：${target.name}` : '已复制文件路径' };
        }
        case 'copy_name': {
          clipboard.writeText(target.name || (normAbs ? path.basename(normAbs) : ''));
          return { ok: true, toast: '已复制文件名' };
        }
        case 'copy_rel_path': {
          clipboard.writeText(target.relativePath || normAbs || '');
          return { ok: true, toast: '已复制相对路径' };
        }
        case 'copy_uri': {
          clipboard.writeText(target.fileUri || (normAbs ? toFileUriSafe(normAbs) : ''));
          return { ok: true, toast: '已复制 file:// 链接' };
        }
        case 'copy_text': {
          clipboard.writeText(target.selectedText || normAbs || '');
          return { ok: true, toast: '已复制所选文本' };
        }
        default:
          return { ok: false, error: `未知操作: ${String(action)}` };
      }
    }

    ipcMain.handle('ag-reveal:resolve', (_event, payload) => {
      try {
        return resolveCandidates(payload);
      } catch {
        return { canReveal: false, exists: false };
      }
    });

    ipcMain.handle('ag-reveal:execute', async (_event, action, target) => {
      try {
        return await executeAction(action, target);
      } catch (err) {
        return { ok: false, error: (err && err.message) || '执行失败' };
      }
    });

    ipcMain.handle('ag-reveal:popup-menu', async (event, payload) => {
      try {
        const target = resolveCandidates(payload);
        if (!target || !target.canReveal) {
          return { shown: false };
        }
        const win = (BrowserWindow && event && event.sender)
          ? (BrowserWindow.fromWebContents(event.sender) || BrowserWindow.getFocusedWindow())
          : BrowserWindow.getFocusedWindow();
        if (!win || !Menu) {
          return { shown: false };
        }

        const copyMoreSubmenu = [
          { id: 'copy_name', label: '复制文件名' }
        ];
        if (target.relativePath) {
          copyMoreSubmenu.push({ id: 'copy_rel_path', label: '复制相对路径' });
        }
        if (target.fileUri) {
          copyMoreSubmenu.push({ id: 'copy_uri', label: '复制 file:// 链接' });
        }
        if (target.selectedText) {
          copyMoreSubmenu.push({ type: 'separator' });
          copyMoreSubmenu.push({ id: 'copy_text', label: '复制所选文本' });
        }

        const openSubmenu = [];
        if (target.exists) {
          openSubmenu.push({ id: 'open_default', label: '系统默认应用' });
        }
        if (target.isDir && target.exists) {
          openSubmenu.push({ id: 'open_folder', label: '打开文件夹' });
        } else {
          openSubmenu.push({ id: 'open_folder', label: '打开所在文件夹' });
        }
        openSubmenu.push({ id: 'open_terminal', label: '在终端中打开所在文件夹' });

        const primaryLabel = target.exists ? revealLabel() : '打开所在文件夹（文件已不存在）';

        const chosenId = await new Promise((resolve) => {
          let settled = false;
          const finish = (id) => {
            if (!settled) {
              settled = true;
              resolve(id || null);
            }
          };

          const wrapItems = (items) => items.map((it) => {
            if (it.type === 'separator') return { type: 'separator' };
            if (Array.isArray(it.submenu)) {
              return {
                label: it.label,
                submenu: wrapItems(it.submenu)
              };
            }
            return {
              label: it.label,
              enabled: it.enabled !== false,
              click: () => finish(it.id)
            };
          });

          const template = wrapItems([
            { id: 'attach', label: '作为上下文附加' },
            { id: 'copy_path', label: '复制文件路径' },
            { label: '复制更多', submenu: copyMoreSubmenu },
            { type: 'separator' },
            { label: '打开方式', submenu: openSubmenu },
            { id: 'show_in_folder', label: primaryLabel }
          ]);

          const menu = Menu.buildFromTemplate(template);
          menu.popup({
            window: win,
            callback: () => {
              setImmediate(() => finish(null));
            }
          });
        });

        if (!chosenId) {
          return { shown: true, action: null, target };
        }
        if (chosenId === 'attach') {
          return { shown: true, action: 'attach', target };
        }
        const execRes = await executeAction(chosenId, target);
        return {
          shown: true,
          action: chosenId,
          target,
          ok: execRes.ok,
          toast: execRes.toast || execRes.error || ''
        };
      } catch (err) {
        return { shown: false, error: (err && err.message) || '菜单弹出失败' };
      }
    });
  } catch (err) {
    try {
      console.error('[ag-reveal-in-explorer] main init error:', err);
    } catch {}
  }
  }
})();
// ===== AG_REVEAL_EXPLORER_END =====
