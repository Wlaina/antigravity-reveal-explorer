'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');

process.env.AG_REVEAL_EXPORT_HELPERS = '1';
require('../src/main_reveal.js');
const helpers = globalThis.__AG_REVEAL_HELPERS__;
assert.ok(helpers, 'Expected __AG_REVEAL_HELPERS__ to be exported');

const { readAsarLayout } = require('../src/asar_patcher.js');
const setup = require('../setup.cjs');

function runPathResolutionTests() {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-reveal-unit-'));
  try {
    const subDir = path.join(tmpRoot, 'books', '中文目录');
    const nmDir = path.join(tmpRoot, 'node_modules', 'pkg');
    fs.mkdirSync(subDir, { recursive: true });
    fs.mkdirSync(nmDir, { recursive: true });

    const epubFile = path.join(subDir, '女之旅.epub');
    const spaceFile = path.join(tmpRoot, 'my notes (1).md');
    const nmFile = path.join(nmDir, 'ignored_only.txt');
    fs.writeFileSync(epubFile, 'epub', 'utf8');
    fs.writeFileSync(spaceFile, '# notes\n', 'utf8');
    fs.writeFileSync(nmFile, 'skip', 'utf8');

    // 1. file:// URI 解析测试（全部采用通用示例路径）
    if (process.platform === 'win32') {
      assert.equal(
        helpers.parseFileUriToLocalPath('file:///d%3A/Projects/%E4%B8%AD%E6%96%87%E7%9B%AE%E5%BD%95/demo/rules.md#L10-L20'),
        path.win32.normalize('d:\\Projects\\中文目录\\demo\\rules.md')
      );
      assert.equal(
        helpers.parseFileUriToLocalPath('file://d:/Projects/demo/rules.md?foo=1'),
        path.win32.normalize('d:\\Projects\\demo\\rules.md')
      );
      assert.equal(
        helpers.parseFileUriToLocalPath('file:///C:/Users/DemoUser/test%20file.epub'),
        path.win32.normalize('C:\\Users\\DemoUser\\test file.epub')
      );
      assert.equal(
        helpers.parseFileUriToLocalPath('file:///C:/tmp/100%_bad.txt'),
        path.win32.normalize('C:\\tmp\\100%_bad.txt')
      );
    }

    // 2. 显式 file:// URI 解析（存在文件 & 已删除但父目录存在）
    const existingUriRes = helpers.resolveCandidates({
      candidates: [{ value: pathToFileURL(epubFile).href + '#L1-L2', kind: 'file-uri' }],
      extraRoots: [tmpRoot]
    });
    assert.equal(existingUriRes.canReveal, true);
    assert.equal(existingUriRes.exists, true);
    assert.equal(existingUriRes.absPath, path.normalize(epubFile));
    assert.equal(existingUriRes.name, '女之旅.epub');

    const missingFileInExistingDir = path.join(subDir, 'deleted_book.epub');
    const missingUriRes = helpers.resolveCandidates({
      candidates: [{ value: pathToFileURL(missingFileInExistingDir).href, kind: 'file-uri' }],
      extraRoots: [tmpRoot]
    });
    assert.equal(missingUriRes.canReveal, true);
    assert.equal(missingUriRes.exists, false);
    assert.equal(missingUriRes.existingParent, path.normalize(subDir));

    // 3. 绝对路径（含 :line:col 行号后缀与括号文件名）
    const absColonRes = helpers.resolveCandidates({
      candidates: [{ value: `${spaceFile}:12:4`, kind: 'code-path' }],
      extraRoots: [tmpRoot]
    });
    assert.equal(absColonRes.canReveal, true);
    assert.equal(absColonRes.exists, true);
    assert.equal(absColonRes.absPath, path.normalize(spaceFile));

    // 4. 相对路径
    const relRes = helpers.resolveCandidates({
      candidates: [{ value: './books/中文目录/女之旅.epub', kind: 'text' }],
      extraRoots: [tmpRoot]
    });
    assert.equal(relRes.canReveal, true);
    assert.equal(relRes.absPath, path.normalize(epubFile));
    assert.equal(relRes.relativePath, path.join('books', '中文目录', '女之旅.epub'));

    // 5. 有界 BFS 纯文件名匹配（且跳过 node_modules）
    const bfsHit = helpers.resolveCandidates({
      candidates: [{ value: '女之旅.epub', kind: 'text' }],
      extraRoots: [tmpRoot]
    });
    assert.equal(bfsHit.canReveal, true);
    assert.equal(bfsHit.absPath, path.normalize(epubFile));

    const bfsParenHit = helpers.resolveCandidates({
      candidates: [{ value: 'my notes (1).md', kind: 'text' }],
      extraRoots: [tmpRoot]
    });
    assert.equal(bfsParenHit.canReveal, true);
    assert.equal(bfsParenHit.absPath, path.normalize(spaceFile));

    const nmSkipped = helpers.resolveCandidates({
      candidates: [{ value: 'ignored_only.txt', kind: 'text' }],
      extraRoots: [tmpRoot]
    });
    assert.equal(nmSkipped.canReveal, false);

    // 6. 零误报测试：普通代码标识符与 HTTP URL 必须返回 canReveal: false
    for (const noise of ['console.log', 'foo.bar', 'e.preventDefault', 'https://example.com/女之旅.epub', '1.0.0', 'definitely_missing_xyz.md']) {
      const res = helpers.resolveCandidates({
        candidates: [{ value: noise, kind: 'text' }],
        extraRoots: [tmpRoot]
      });
      assert.equal(res.canReveal, false, `Noise candidate should not resolve: ${noise}`);
    }
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
}

function runMenuContractTests() {
  const repoRoot = path.resolve(__dirname, '..');
  const mainReveal = fs.readFileSync(path.join(repoRoot, 'src', 'main_reveal.js'), 'utf8');
  const preloadReveal = fs.readFileSync(path.join(repoRoot, 'src', 'preload_reveal.js'), 'utf8');

  assert.ok(mainReveal.includes("{ id: 'copy_path', label: '复制文件路径' }"), 'main_reveal.js must expose top-level copy_path item');
  assert.ok(preloadReveal.includes('menuContainsCopyPath'), 'preload_reveal.js must check existing copy path items independently');
  assert.ok(preloadReveal.includes('appendDomMenuFileItems'), 'preload_reveal.js must augment DOM menus with copy file path and reveal items');
  assert.ok(preloadReveal.includes("createDomMenuItem(sampleItem, '复制文件路径'"), 'DOM menu augmentation must include 复制文件路径');
  assert.ok(preloadReveal.includes('在资源管理器中显示'), 'DOM menu augmentation must include 在资源管理器中显示');
}

function runAsarRoundTripTests() {
  const realResDir = setup.resolveAntigravityResourcesDir('');
  if (!realResDir) {
    console.log('[ag-reveal-in-explorer] Antigravity resources dir not found; skipping local ASAR round-trip test.');
    return;
  }
  const realAsar = path.join(realResDir, 'app.asar');
  assert.ok(fs.existsSync(realAsar), 'Real app.asar must exist');

  const tmpResDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-reveal-asar-'));
  try {
    const workAsar = path.join(tmpResDir, 'app.asar');
    fs.copyFileSync(realAsar, workAsar);

    const origLayout = readAsarLayout(workAsar);
    const origMainClean = setup.stripRevealMarkers(origLayout.files.get('dist/main.js').body.toString('utf8')) + '\n';
    const origPreloadClean = setup.stripRevealMarkers(origLayout.files.get('dist/preload.js').body.toString('utf8')) + '\n';

    // 1. 第一次打补丁
    const patch1 = setup.buildPatchedAsar(tmpResDir, false);
    assert.equal(patch1.ok, true);
    fs.copyFileSync(patch1.stagedPath, workAsar);
    fs.rmSync(patch1.stagedPath, { force: true });

    const markers1 = setup.inspectArchiveMarkers(workAsar);
    assert.equal(markers1.revealMainPatched, true);
    assert.equal(markers1.revealPreloadPatched, true);

    const layout1 = readAsarLayout(workAsar);
    const mainBuf1 = layout1.files.get('dist/main.js').body;
    const preloadBuf1 = layout1.files.get('dist/preload.js').body;

    // 2. 语法检查
    const chkDir = path.join(tmpResDir, 'syntax');
    fs.mkdirSync(chkDir, { recursive: true });
    fs.writeFileSync(path.join(chkDir, 'main.js'), mainBuf1);
    fs.writeFileSync(path.join(chkDir, 'preload.js'), preloadBuf1);
    execFileSync(process.execPath, ['--check', path.join(chkDir, 'main.js')], { stdio: 'pipe' });
    execFileSync(process.execPath, ['--check', path.join(chkDir, 'preload.js')], { stdio: 'pipe' });

    // 3. 幂等性验证：连续打两次补丁内容完全一致
    const patch2 = setup.buildPatchedAsar(tmpResDir, false);
    assert.equal(patch2.ok, true);
    fs.copyFileSync(patch2.stagedPath, workAsar);
    fs.rmSync(patch2.stagedPath, { force: true });

    const layout2 = readAsarLayout(workAsar);
    assert.equal(mainBuf1.equals(layout2.files.get('dist/main.js').body), true, 'Idempotent patch mismatch on dist/main.js');
    assert.equal(preloadBuf1.equals(layout2.files.get('dist/preload.js').body), true, 'Idempotent patch mismatch on dist/preload.js');

    // 4. 卸载剥离验证（确认原有代码主体完整还原）
    const unpatch = setup.buildPatchedAsar(tmpResDir, true);
    assert.equal(unpatch.ok, true);
    fs.copyFileSync(unpatch.stagedPath, workAsar);
    fs.rmSync(unpatch.stagedPath, { force: true });

    const markersAfterUninstall = setup.inspectArchiveMarkers(workAsar);
    assert.equal(markersAfterUninstall.revealMainPatched, false);
    assert.equal(markersAfterUninstall.revealPreloadPatched, false);

    const layout3 = readAsarLayout(workAsar);
    const mainAfterText = layout3.files.get('dist/main.js').body.toString('utf8');
    const preloadAfterText = layout3.files.get('dist/preload.js').body.toString('utf8');
    assert.equal(mainAfterText, origMainClean, 'Uninstall must restore original dist/main.js cleanly');
    assert.equal(preloadAfterText, origPreloadClean, 'Uninstall must restore original dist/preload.js cleanly');

    fs.writeFileSync(path.join(chkDir, 'main_clean.js'), layout3.files.get('dist/main.js').body);
    fs.writeFileSync(path.join(chkDir, 'preload_clean.js'), layout3.files.get('dist/preload.js').body);
    execFileSync(process.execPath, ['--check', path.join(chkDir, 'main_clean.js')], { stdio: 'pipe' });
    execFileSync(process.execPath, ['--check', path.join(chkDir, 'preload_clean.js')], { stdio: 'pipe' });
  } finally {
    fs.rmSync(tmpResDir, { recursive: true, force: true });
  }
}

function runBatchEncodingAndDryRunTests() {
  const repoRoot = path.resolve(__dirname, '..');
  const batNames = [
    '双击安装右键资源管理器插件.bat',
    '双击卸载右键资源管理器插件.bat',
    '一键更新并重装插件.bat'
  ];
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-reveal-bat-'));
  try {
    for (const name of batNames) {
      const batPath = path.join(repoRoot, name);
      assert.equal(fs.existsSync(batPath), true, `Missing batch file: ${name}`);
      const buf = fs.readFileSync(batPath);
      const hasBom = buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf;
      assert.equal(hasBom, false, `Batch file must not have UTF-8 BOM: ${name}`);
      const bin = buf.toString('binary');
      const crlfCount = (bin.match(/\r\n/g) || []).length;
      const lfOnlyCount = (bin.match(/(?<!\r)\n/g) || []).length;
      assert.ok(crlfCount > 0, `Batch file must use CRLF line endings: ${name}`);
      assert.equal(lfOnlyCount, 0, `Batch file must not contain bare LF: ${name}`);

      if (process.platform === 'win32') {
        const dryText = buf
          .toString('utf8')
          .replace(/git pull[^\r\n]*/g, 'echo DRY_PULL_OK')
          .replace(/node setup\.cjs[^\r\n]*/g, 'echo DRY_RUN_OK')
          .replace(/\bpause\b/g, 'echo WOULD_PAUSE')
          .replace(/timeout\s+\/t\s+\d+\s*>nul/gi, 'echo WOULD_WAIT');
        const dryPath = path.join(tmpDir, name);
        fs.writeFileSync(dryPath, dryText.replace(/\r\n/g, '\n').replace(/\n/g, '\r\n'), 'utf8');
        const out = execFileSync('cmd.exe', ['/c', dryPath], { encoding: 'utf8', timeout: 6000 });
        assert.ok(out.includes('DRY_RUN_OK'), `Dry-run batch failed to reach command line in ${name}: ${out}`);
        assert.equal(out.includes('is not recognized'), false, `Batch line parsing corrupted in ${name}: ${out}`);
      }
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

runPathResolutionTests();
runMenuContractTests();
runAsarRoundTripTests();
runBatchEncodingAndDryRunTests();
console.log('[ag-reveal-in-explorer] All unit, menu contract, batch, and ASAR round-trip tests passed!');
