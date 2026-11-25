#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync, spawn } = require('node:child_process');
const { readAsarLayout, patchAsarArchive, validateAsarCandidate } = require('./src/asar_patcher');

const REPO_ROOT = __dirname;
const PLUGIN_ID = 'ag-reveal-in-explorer';
const GEMINI_CONFIG_DIR = process.env.ANTIGRAVITY_CONFIG_DIR
  ? path.resolve(process.env.ANTIGRAVITY_CONFIG_DIR)
  : path.join(os.homedir(), '.gemini', 'config');

const PLUGIN_DEST_DIR = path.join(GEMINI_CONFIG_DIR, 'plugins', PLUGIN_ID);
const BEGIN_MARKER = '// ===== AG_REVEAL_EXPLORER_BEGIN =====';
const END_MARKER = '// ===== AG_REVEAL_EXPLORER_END =====';
const STAGED_FILENAME = 'app.asar.reveal-staged';
const BACKUP_FILENAME = 'app.asar.reveal.bak';

function copyFileSafe(src, dst) {
  const absSrc = path.resolve(src);
  const absDst = path.resolve(dst);
  if (absSrc === absDst) return;
  fs.mkdirSync(path.dirname(absDst), { recursive: true });
  if (/\.bat$/i.test(absDst)) {
    const raw = fs.readFileSync(absSrc, 'utf8').replace(/\r\n/g, '\n').replace(/\n/g, '\r\n');
    fs.writeFileSync(absDst, raw, 'utf8');
    return;
  }
  fs.copyFileSync(absSrc, absDst);
}

function resolveAntigravityResourcesDir(explicitDir) {
  if (explicitDir && fs.existsSync(path.join(explicitDir, 'app.asar'))) return explicitDir;
  const candidates = [];
  if (process.platform === 'win32') {
    const localApp = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
    candidates.push(
      path.join(localApp, 'Programs', 'antigravity', 'resources'),
      path.join(localApp, 'Programs', 'Antigravity', 'resources')
    );
  } else if (process.platform === 'darwin') {
    candidates.push('/Applications/Antigravity.app/Contents/Resources');
  } else {
    candidates.push(
      '/opt/Antigravity/resources',
      '/usr/share/antigravity/resources',
      path.join(os.homedir(), '.local', 'share', 'antigravity', 'resources')
    );
  }
  for (const dir of candidates) {
    if (fs.existsSync(path.join(dir, 'app.asar'))) return dir;
  }
  return '';
}

function isAntigravityRunning() {
  if (process.platform !== 'win32') return false;
  try {
    const out = execFileSync(
      'powershell.exe',
      ['-NoProfile', '-Command', "(Get-Process -Name 'Antigravity' -ErrorAction SilentlyContinue).Count"],
      { encoding: 'utf8', timeout: 4000 }
    ).trim();
    return parseInt(out, 10) > 0;
  } catch {
    return false;
  }
}

function killAntigravityWindows() {
  if (process.platform !== 'win32') return;
  try {
    execFileSync('taskkill.exe', ['/f', '/im', 'Antigravity.exe', '/t'], { stdio: 'ignore', timeout: 6000 });
  } catch {}
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline && isAntigravityRunning()) {
    sleepSync(150);
  }
}

function relaunchAntigravityWindows(resourcesDir) {
  if (process.platform !== 'win32' || !resourcesDir) return;
  const exe = path.join(path.dirname(resourcesDir), 'Antigravity.exe');
  if (!fs.existsSync(exe)) return;
  try {
    const child = spawn(exe, [], { detached: true, stdio: 'ignore', windowsHide: false });
    child.unref();
  } catch {}
}

function stripRevealMarkers(text) {
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`\\n?${esc(BEGIN_MARKER)}[\\s\\S]*?${esc(END_MARKER)}\\n?`, 'g');
  return String(text || '').replace(re, '').trimEnd();
}

function installPluginFiles() {
  const filesToCopy = [
    ['plugin.json', 'plugin.json'],
    ['README.md', 'README.md'],
    ['LICENSE', 'LICENSE'],
    ['setup.cjs', 'setup.cjs'],
    ['双击安装右键资源管理器插件.bat', '双击安装右键资源管理器插件.bat'],
    ['双击卸载右键资源管理器插件.bat', '双击卸载右键资源管理器插件.bat'],
    ['一键更新并重装插件.bat', '一键更新并重装插件.bat'],
    [path.join('assets', 'logo.svg'), path.join('assets', 'logo.svg')],
    [path.join('skills', PLUGIN_ID, 'SKILL.md'), path.join('skills', PLUGIN_ID, 'SKILL.md')],
    [path.join('src', 'asar_patcher.js'), path.join('src', 'asar_patcher.js')],
    [path.join('src', 'main_reveal.js'), path.join('src', 'main_reveal.js')],
    [path.join('src', 'preload_reveal.js'), path.join('src', 'preload_reveal.js')]
  ];

  fs.mkdirSync(PLUGIN_DEST_DIR, { recursive: true });
  for (const [relSrc, relDst] of filesToCopy) {
    const src = path.join(REPO_ROOT, relSrc);
    const dst = path.join(PLUGIN_DEST_DIR, relDst);
    if (fs.existsSync(src)) {
      copyFileSafe(src, dst);
    }
  }
  return { pluginDir: PLUGIN_DEST_DIR };
}

function buildPatchedAsar(resourcesDir, stripOnly = false) {
  const asarPath = path.join(resourcesDir, 'app.asar');
  const stagedPath = path.join(resourcesDir, STAGED_FILENAME);
  const revealBakPath = path.join(resourcesDir, BACKUP_FILENAME);
  const existingBakPath = path.join(resourcesDir, 'app.asar.bak');

  if (!fs.existsSync(asarPath)) {
    return { ok: false, error: `app.asar not found in ${resourcesDir}` };
  }

  const mainReveal = fs.readFileSync(path.join(REPO_ROOT, 'src', 'main_reveal.js'), 'utf8').trim();
  const preloadReveal = fs.readFileSync(path.join(REPO_ROOT, 'src', 'preload_reveal.js'), 'utf8').trim();

  const buildDir = fs.mkdtempSync(path.join(resourcesDir, '.ag-reveal-build-'));
  try {
    const sourceCopy = path.join(buildDir, 'source.asar');
    fs.copyFileSync(asarPath, sourceCopy);
    if (!fs.existsSync(revealBakPath) && !fs.existsSync(existingBakPath)) {
      fs.copyFileSync(asarPath, revealBakPath);
    }
    const candidatePath = path.join(buildDir, 'candidate.asar');

    const modifierMap = new Map([
      [
        'dist/main.js',
        (orig) => {
          const cleaned = stripRevealMarkers(orig);
          return stripOnly ? cleaned + '\n' : cleaned + '\n\n' + mainReveal + '\n';
        }
      ],
      [
        'dist/preload.js',
        (orig) => {
          const cleaned = stripRevealMarkers(orig);
          return stripOnly ? cleaned + '\n' : cleaned + '\n\n' + preloadReveal + '\n';
        }
      ]
    ]);

    const modified = patchAsarArchive(sourceCopy, candidatePath, modifierMap);
    if (!modified.has('dist/main.js') || !modified.has('dist/preload.js')) {
      throw new Error('app.asar is missing dist/main.js or dist/preload.js');
    }

    const requiredMarkers = stripOnly
      ? []
      : [
          { file: 'dist/main.js', marker: BEGIN_MARKER },
          { file: 'dist/preload.js', marker: BEGIN_MARKER }
        ];
    validateAsarCandidate(sourceCopy, candidatePath, ['dist/main.js', 'dist/preload.js'], requiredMarkers);

    for (const [relPath, buf] of modified.entries()) {
      const checkPath = path.join(buildDir, path.basename(relPath));
      fs.writeFileSync(checkPath, buf);
      execFileSync(process.execPath, ['--check', checkPath], { stdio: 'pipe' });
    }

    fs.copyFileSync(candidatePath, stagedPath);
    return { ok: true, asarPath, stagedPath };
  } finally {
    try {
      fs.rmSync(buildDir, { recursive: true, force: true });
    } catch {}
  }
}

function sleepSync(ms) {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch {
    const end = Date.now() + ms;
    while (Date.now() < end) {}
  }
}

function trySwapStagedAsar(asarPath, stagedPath, allowKill) {
  if (!fs.existsSync(stagedPath)) return { applied: false, reason: 'No staged asar' };
  if (allowKill) {
    killAntigravityWindows();
  }
  const maxAttempts = allowKill ? 30 : 1;
  const retryDelayMs = 200;
  let lastErr = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const tmpPrev = `${asarPath}.prev.${Date.now()}`;
    try {
      const fd = fs.openSync(asarPath, 'r+');
      fs.closeSync(fd);
      fs.copyFileSync(asarPath, tmpPrev);
      fs.copyFileSync(stagedPath, asarPath);
      fs.rmSync(stagedPath, { force: true });
      fs.rmSync(tmpPrev, { force: true });
      return { applied: true };
    } catch (err) {
      lastErr = err;
      try {
        if (fs.existsSync(tmpPrev)) {
          fs.copyFileSync(tmpPrev, asarPath);
          fs.rmSync(tmpPrev, { force: true });
        }
      } catch {}
      const code = err && err.code;
      const retryable = code === 'EBUSY' || code === 'EPERM' || code === 'EACCES';
      if (attempt < maxAttempts && retryable) {
        sleepSync(retryDelayMs);
        continue;
      }
      break;
    }
  }
  return {
    applied: false,
    reason: (lastErr && (lastErr.code || lastErr.message)) || 'Swap failed',
    locked: true
  };
}

function inspectArchiveMarkers(archivePath) {
  const layout = readAsarLayout(archivePath);
  const mainFile = layout.files.get('dist/main.js');
  const preloadFile = layout.files.get('dist/preload.js');
  const mainHasReveal = Boolean(mainFile && mainFile.body && mainFile.body.includes(Buffer.from(BEGIN_MARKER, 'utf8')));
  const preloadHasReveal = Boolean(preloadFile && preloadFile.body && preloadFile.body.includes(Buffer.from(BEGIN_MARKER, 'utf8')));
  return {
    revealMainPatched: mainHasReveal,
    revealPreloadPatched: preloadHasReveal
  };
}

function checkAsarStatus(resourcesDir) {
  const out = {
    resourcesDir: resourcesDir || '',
    asarExists: false,
    revealMainPatched: false,
    revealPreloadPatched: false,
    stagedReady: false,
    stagedValid: false
  };
  if (!resourcesDir) return out;
  const asarPath = path.join(resourcesDir, 'app.asar');
  const stagedPath = path.join(resourcesDir, STAGED_FILENAME);
  out.stagedReady = fs.existsSync(stagedPath);

  if (out.stagedReady) {
    try {
      const stagedInfo = inspectArchiveMarkers(stagedPath);
      out.stagedValid = Boolean(stagedInfo.revealMainPatched && stagedInfo.revealPreloadPatched);
    } catch {
      out.stagedValid = false;
    }
  }

  if (!fs.existsSync(asarPath)) return out;
  out.asarExists = true;
  try {
    const liveInfo = inspectArchiveMarkers(asarPath);
    out.revealMainPatched = liveInfo.revealMainPatched;
    out.revealPreloadPatched = liveInfo.revealPreloadPatched;
  } catch {}

  return out;
}

function checkStatus(resourcesDir) {
  const pluginOk =
    fs.existsSync(path.join(PLUGIN_DEST_DIR, 'plugin.json')) &&
    fs.existsSync(path.join(PLUGIN_DEST_DIR, 'src', 'main_reveal.js')) &&
    fs.existsSync(path.join(PLUGIN_DEST_DIR, 'src', 'preload_reveal.js'));
  const skillOk = fs.existsSync(path.join(PLUGIN_DEST_DIR, 'skills', PLUGIN_ID, 'SKILL.md'));
  const asarStatus = checkAsarStatus(resourcesDir);

  const report = {
    platform: process.platform,
    configDir: GEMINI_CONFIG_DIR,
    pluginDir: PLUGIN_DEST_DIR,
    pluginInstalled: pluginOk,
    skillInstalled: skillOk,
    asarStatus
  };
  console.log(JSON.stringify(report, null, 2));
  if (!pluginOk || !skillOk) process.exitCode = 1;
}

async function main() {
  const args = process.argv.slice(2);
  const idxDir = args.indexOf('--install-dir');
  const explicitDir = idxDir !== -1 ? args[idxDir + 1] : '';
  const resourcesDir = resolveAntigravityResourcesDir(explicitDir);

  if (args.includes('--check')) {
    checkStatus(resourcesDir);
    return;
  }

  if (args.includes('--uninstall')) {
    if (resourcesDir && fs.existsSync(path.join(resourcesDir, 'app.asar'))) {
      const res = buildPatchedAsar(resourcesDir, true);
      if (res.ok) {
        const allowKill = args.includes('--kill');
        const swap = trySwapStagedAsar(res.asarPath, res.stagedPath, allowKill);
        console.log('[ag-reveal-in-explorer] Uninstall ASAR swap:', swap);
        if (!swap.applied) {
          console.log('[ag-reveal-in-explorer] Staged clean ASAR at:', res.stagedPath);
          if (allowKill) process.exitCode = 1;
        } else if (args.includes('--relaunch')) {
          relaunchAntigravityWindows(resourcesDir);
        }
      }
    }
    if (fs.existsSync(PLUGIN_DEST_DIR) && path.resolve(PLUGIN_DEST_DIR) !== path.resolve(REPO_ROOT)) {
      fs.rmSync(PLUGIN_DEST_DIR, { recursive: true, force: true });
    }
    console.log('[ag-reveal-in-explorer] Uninstalled cleanly.');
    return;
  }

  if (args.includes('--apply-staged')) {
    if (!resourcesDir) throw new Error('Antigravity resources directory not found');
    const asarPath = path.join(resourcesDir, 'app.asar');
    const stagedPath = path.join(resourcesDir, STAGED_FILENAME);
    if (!fs.existsSync(stagedPath)) {
      buildPatchedAsar(resourcesDir, false);
    }
    const swap = trySwapStagedAsar(asarPath, stagedPath, args.includes('--kill'));
    console.log('[ag-reveal-in-explorer] Apply staged ASAR:', swap);
    if (!swap.applied) process.exitCode = 1;
    else if (args.includes('--relaunch')) relaunchAntigravityWindows(resourcesDir);
    return;
  }

  // 默认安装：同步插件文件 + 构建并尝试写入 app.asar
  const pluginRes = installPluginFiles();
  console.log('[ag-reveal-in-explorer] Plugin files installed:', pluginRes.pluginDir);

  if (resourcesDir && !args.includes('--plugin-only')) {
    const built = buildPatchedAsar(resourcesDir, false);
    if (built.ok) {
      const allowKill = args.includes('--kill');
      const swap = trySwapStagedAsar(built.asarPath, built.stagedPath, allowKill);
      if (swap.applied) {
        console.log('[ag-reveal-in-explorer] ASAR patch applied successfully!');
        if (args.includes('--relaunch')) relaunchAntigravityWindows(resourcesDir);
      } else {
        console.log('[ag-reveal-in-explorer] Antigravity is running; validated ASAR staged at:');
        console.log('  ', built.stagedPath);
        console.log('  Run `双击安装右键资源管理器插件.bat` (or `node setup.cjs --apply-staged --kill --relaunch`) to apply and restart Antigravity.');
        if (allowKill) process.exitCode = 1;
      }
    }
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error('[ag-reveal-in-explorer] Setup failed:', err);
    process.exit(1);
  });
}

module.exports = {
  PLUGIN_ID,
  BEGIN_MARKER,
  END_MARKER,
  STAGED_FILENAME,
  stripRevealMarkers,
  buildPatchedAsar,
  inspectArchiveMarkers,
  checkAsarStatus,
  resolveAntigravityResourcesDir
};
