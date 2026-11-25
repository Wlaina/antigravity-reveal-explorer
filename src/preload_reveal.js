// ===== AG_REVEAL_EXPLORER_BEGIN =====
(function () {
  'use strict';

  try {
    if (window.top !== window || globalThis.__AG_REVEAL_PRELOAD__) return;
    if (Array.isArray(process?.argv) && process.argv.some((arg) => String(arg).startsWith('--agy-backend=ssh'))) {
      return;
    }
    globalThis.__AG_REVEAL_PRELOAD__ = true;

    const { ipcRenderer } = require('electron');

    const UUID_EXTRACT_RE = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i;
    const CUSTOM_MENU_IDS = {
      attach: '__ag_reveal_attach__',
      copyPath: '__ag_reveal_copy_path__',
      copyName: '__ag_reveal_copy_name__',
      copyRelPath: '__ag_reveal_copy_rel_path__',
      copyUri: '__ag_reveal_copy_uri__',
      openDefault: '__ag_reveal_open_default__',
      openFolder: '__ag_reveal_open_folder__',
      openTerminal: '__ag_reveal_open_terminal__',
      showInFolder: '__ag_reveal_show_in_folder__'
    };
    const EXISTING_REVEAL_LABELS = new Set([
      'reveal in file explorer',
      'reveal in finder',
      '在文件资源管理器中显示',
      '在资源管理器中显示',
      '在访达中显示',
      '在文件管理器中显示'
    ]);
    const EXISTING_COPY_PATH_LABELS = new Set([
      'copy file path',
      'copy path',
      '复制文件路径',
      '复制路径'
    ]);

    const rawInvoke = ipcRenderer.invoke.bind(ipcRenderer);
    let pendingClick = null;
    let toastTimer = null;

    function isInsideIgnoredArea(el) {
      if (!el || typeof el.closest !== 'function') return false;
      return Boolean(el.closest('#gemini-neko-pet-root, #gemini-neko-observer-modal'));
    }

    function isEditableElement(el) {
      if (!el || typeof el.closest !== 'function') return false;
      return Boolean(el.closest('textarea, input, [contenteditable="true"], [contenteditable=""]'));
    }

    function getConversationContext() {
      let convId = '';
      try {
        const m = String(window.location.href || '').match(UUID_EXTRACT_RE);
        if (m) convId = m[1].toLowerCase();
      } catch {}

      let projectHint = '';
      try {
        const header = document.querySelector('[data-testid="project-header"], [data-testid="project-selector-trigger"]');
        if (header && header.textContent) {
          projectHint = header.textContent.trim().slice(0, 120);
        }
      } catch {}

      const pageFileHints = [];
      try {
        const anchors = document.querySelectorAll('a[href^="file://"]');
        for (const a of anchors) {
          const href = a.getAttribute('href');
          if (href && !pageFileHints.includes(href)) {
            pageFileHints.push(href);
            if (pageFileHints.length >= 12) break;
          }
        }
      } catch {}

      return { convId, projectHint, pageFileHints };
    }

    function splitPotentialPathsFromText(text) {
      const results = [];
      if (typeof text !== 'string') return results;
      const trimmed = text.trim();
      if (!trimmed || trimmed.length > 420 || /[\r\n]/.test(trimmed)) return results;

      results.push(trimmed);

      // 若包含 "文件名 (路径)" 或空格分隔的内容，抽取其中的 file:// / 盘符路径 / 带扩展名片段
      const fileUriMatch = trimmed.match(/file:\/\/[^\s"'`<>()]+/i);
      if (fileUriMatch) results.push(fileUriMatch[0]);

      const winAbsMatch = trimmed.match(/[A-Za-z]:[\\/][^\r\n"'`<>]+/);
      if (winAbsMatch) results.push(winAbsMatch[0].trim());

      const relMatch = trimmed.match(/(?:\.[\\/]|~[\\/])?[\w\u4e00-\u9fff.\- ]+[\\/][\w\u4e00-\u9fff.\- \\/]+/);
      if (relMatch) results.push(relMatch[0].trim());

      const extMatch = trimmed.match(/[\w\u4e00-\u9fff.\-()]+\.[A-Za-z0-9]{1,10}(?::\d+(?::\d+)?)?(?:#L\d+(?:-L?\d+)?)?/);
      if (extMatch) results.push(extMatch[0].trim());

      return results;
    }

    function looksStronglyLikeFileCandidate(val) {
      if (typeof val !== 'string') return false;
      const s = val.trim();
      if (!s || s.length > 420 || /[\r\n]/.test(s)) return false;
      if (/^file:\/\//i.test(s)) return true;
      if (/^[A-Za-z]:[\\/]/.test(s) || /^~[\\/]/.test(s) || /^\\\\[^\\]+\\[^\\]+/.test(s)) return true;
      if (/^(?:\.[\\/])?[^\s]+[\\/][^\s]+/.test(s) && !/^https?:\/\//i.test(s)) return true;
      const cleaned = s.replace(/^[`'"“”‘’<]+|[`'"“”‘’>.,;!?]+$/g, '');
      if (/^[A-Za-z0-9_\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af .\-()]+\.[A-Za-z0-9]{1,10}(?::\d+(?::\d+)?)?(?:#L\d+(?:-L?\d+)?)?$/.test(cleaned)) {
        if (/^\d+(?:\.\d+)+$/.test(cleaned)) return false;
        // 避免把常见 JS/TS 成员调用误认为文件
        if (/\b(?:console|window|document|event|target|process|Math|Object|Array|JSON|Promise|e|err)\.[A-Za-z]+$/i.test(cleaned)) {
          return false;
        }
        return true;
      }
      return false;
    }

    /**
     * 从右键命中的 DOM 元素及最多 6 层祖先收集路径候选。
     */
    function extractRightClickPayload(event) {
      const targetEl = event && event.target instanceof Element ? event.target : null;
      if (!targetEl || isInsideIgnoredArea(targetEl)) return null;

      const candidates = [];
      const seen = new Set();
      let hasExplicitFileUri = false;
      let hasStrongCandidate = false;
      const editable = isEditableElement(targetEl);

      const pushCandidate = (val, kind, isExplicitAttr = false) => {
        if (typeof val !== 'string') return;
        const s = val.trim();
        if (!s || s.length > 480 || /[\r\n]/.test(s)) return;
        if (/^(https?|mailto|tel|javascript|data|blob|sidecar|customization):/i.test(s)) return;
        if (/^file:\/\//i.test(s)) hasExplicitFileUri = true;
        if (isExplicitAttr || looksStronglyLikeFileCandidate(s)) hasStrongCandidate = true;
        const key = kind + '::' + s;
        if (seen.has(key)) return;
        seen.add(key);
        candidates.push({ value: s, kind });
      };

      const attrNames = [
        'href',
        'data-href',
        'data-uri',
        'data-url',
        'data-file-uri',
        'data-path',
        'data-file-path',
        'data-filepath',
        'data-full-path',
        'data-abs-path',
        'data-relative-path',
        'title',
        'aria-label'
      ];

      let cur = targetEl;
      for (let depth = 0; depth < 6 && cur && cur !== document.body; depth++) {
        for (const attr of attrNames) {
          const v = cur.getAttribute(attr);
          if (!v) continue;
          const isPathAttr = attr !== 'title' && attr !== 'aria-label';
          if (/^file:\/\//i.test(v)) {
            pushCandidate(v, 'file-uri', true);
          } else if (isPathAttr || looksStronglyLikeFileCandidate(v)) {
            pushCandidate(v, isPathAttr ? 'attr-path' : 'text', isPathAttr);
          }
        }

        // 若点在文件卡片/条目容器内，且容器恰好只有 1 个 file:// 链接则借用该链接
        if (
          typeof cur.matches === 'function' &&
          cur.matches('[data-testid="artifact-card"], [data-testid="bubble-artifact-card"], [data-testid="changed-files-card"], [data-testid*="file"], [data-testid*="artifact"]')
        ) {
          const links = cur.querySelectorAll('a[href^="file://"]');
          if (links.length === 1) {
            pushCandidate(links[0].getAttribute('href'), 'file-uri', true);
          }
        }

        cur = cur.parentElement;
      }

      // 读取选区文本
      let selectedText = '';
      try {
        const sel = window.getSelection();
        if (sel && sel.rangeCount > 0) {
          const selStr = String(sel.toString() || '').trim();
          if (selStr && selStr.length <= 360 && !/[\r\n]/.test(selStr)) {
            selectedText = selStr;
            for (const part of splitPotentialPathsFromText(selStr)) {
              pushCandidate(part, 'selection', false);
            }
          }
        }
      } catch {}

      // 若不是在输入区空处，采集行内 code/a/span/徽章文本
      if (!editable || hasExplicitFileUri) {
        const textAnchor = targetEl.closest('a, code, [data-testid*="file"], [data-testid*="artifact"], span, div');
        if (textAnchor && textAnchor.textContent) {
          const txt = textAnchor.textContent.trim();
          if (txt && txt.length <= 320 && !/[\r\n]/.test(txt)) {
            const tag = textAnchor.tagName;
            const kind = tag === 'CODE' ? 'code-path' : 'text';
            for (const part of splitPotentialPathsFromText(txt)) {
              pushCandidate(part, kind, false);
            }
          }
        }
      }

      if (candidates.length === 0) return null;
      const ctx = getConversationContext();
      return {
        payload: {
          candidates,
          selectedText,
          convId: ctx.convId,
          projectHint: ctx.projectHint,
          pageFileHints: ctx.pageFileHints
        },
        hasExplicitFileUri,
        hasStrongCandidate,
        editable
      };
    }

    function showToast(message) {
      if (!message || !document.body) return;
      try {
        let el = document.getElementById('ag-reveal-explorer-toast');
        if (!el) {
          el = document.createElement('div');
          el.id = 'ag-reveal-explorer-toast';
          el.style.cssText = [
            'position:fixed',
            'left:50%',
            'bottom:28px',
            'transform:translateX(-50%)',
            'z-index:2147483000',
            'pointer-events:none',
            'padding:7px 14px',
            'border-radius:8px',
            'font-size:12.5px',
            'font-weight:500',
            'line-height:1.4',
            'color:var(--foreground, #f8fafc)',
            'background:color-mix(in srgb, var(--background, #18181b) 92%, #000)',
            'border:1px solid color-mix(in srgb, var(--border, #ffffff2e) 90%, transparent)',
            'box-shadow:0 8px 24px rgba(0,0,0,0.32)',
            'opacity:0',
            'transition:opacity 0.16s ease'
          ].join(';');
          document.body.appendChild(el);
        }
        el.textContent = String(message);
        requestAnimationFrame(() => {
          el.style.opacity = '1';
        });
        if (toastTimer) clearTimeout(toastTimer);
        toastTimer = setTimeout(() => {
          if (el) el.style.opacity = '0';
        }, 1900);
      } catch {}
    }

    function attachToChatInput(target) {
      const textToInsert = (target && (target.relativePath || target.absPath || target.name)) || '';
      if (!textToInsert) return;

      const quoted = /\s/.test(textToInsert) ? `"${textToInsert}" ` : `${textToInsert} `;
      try {
        const box = document.querySelector('[data-testid="agent-input-box"]') || document;
        const editor = box.querySelector('[contenteditable="true"], textarea');
        if (editor) {
          editor.focus();
          if (editor.tagName === 'TEXTAREA') {
            const proto = window.HTMLTextAreaElement && window.HTMLTextAreaElement.prototype;
            const setter = proto && Object.getOwnPropertyDescriptor(proto, 'value')?.set;
            const start = typeof editor.selectionStart === 'number' ? editor.selectionStart : editor.value.length;
            const end = typeof editor.selectionEnd === 'number' ? editor.selectionEnd : editor.value.length;
            const nextVal = editor.value.slice(0, start) + quoted + editor.value.slice(end);
            if (setter) setter.call(editor, nextVal);
            else editor.value = nextVal;
            editor.dispatchEvent(new Event('input', { bubbles: true }));
            showToast(`已附加到输入框：${target.name || textToInsert}`);
            return;
          }
          const sel = window.getSelection();
          if (sel) {
            const range = document.createRange();
            range.selectNodeContents(editor);
            range.collapse(false);
            sel.removeAllRanges();
            sel.addRange(range);
          }
          if (typeof document.execCommand === 'function' && document.execCommand('insertText', false, quoted)) {
            showToast(`已附加到输入框：${target.name || textToInsert}`);
            return;
          }
        }
      } catch {}

      // 降级：复制到剪贴板并提示
      void rawInvoke('ag-reveal:execute', 'copy_path', target).then(() => {
        showToast('未能定位输入框，已将路径复制到剪贴板');
      });
    }

    function menuContainsAny(items, labelSet) {
      if (!Array.isArray(items)) return false;
      for (const item of items) {
        if (!item) continue;
        const lbl = typeof item.label === 'string' ? item.label.trim().toLowerCase() : '';
        if (labelSet.has(lbl)) return true;
        if (Array.isArray(item.submenu) && menuContainsAny(item.submenu, labelSet)) return true;
      }
      return false;
    }

    function menuContainsReveal(items) {
      return menuContainsAny(items, EXISTING_REVEAL_LABELS);
    }

    function menuContainsCopyPath(items) {
      return menuContainsAny(items, EXISTING_COPY_PATH_LABELS);
    }

    function menuContainsLabel(items, targetLabel) {
      const needle = targetLabel.toLowerCase();
      for (const item of items || []) {
        if (!item) continue;
        const lbl = typeof item.label === 'string' ? item.label.trim().toLowerCase() : '';
        if (lbl === needle) return true;
        if (Array.isArray(item.submenu) && menuContainsLabel(item.submenu, targetLabel)) return true;
      }
      return false;
    }

    function buildMenuAugmentation(items, target, opts = {}) {
      const hasReveal = Boolean(opts.hasReveal);
      const hasCopyPath = Boolean(opts.hasCopyPath);
      const augmented = items.slice();
      if (augmented.length > 0 && augmented[augmented.length - 1]?.type !== 'separator') {
        augmented.push({ type: 'separator' });
      }
      if (!hasReveal && !menuContainsLabel(augmented, '作为上下文附加') && !menuContainsLabel(augmented, '添加到对话') && !menuContainsLabel(augmented, 'add to chat')) {
        augmented.push({ id: CUSTOM_MENU_IDS.attach, label: '作为上下文附加' });
      }
      if (!hasCopyPath) {
        augmented.push({ id: CUSTOM_MENU_IDS.copyPath, label: '复制文件路径' });
      }
      if (!hasReveal) {
        if (!menuContainsLabel(augmented, '复制更多') && !menuContainsLabel(augmented, '复制') && !menuContainsLabel(augmented, 'copy')) {
          const copyMoreSub = [
            { id: CUSTOM_MENU_IDS.copyName, label: '复制文件名' }
          ];
          if (target.relativePath) {
            copyMoreSub.push({ id: CUSTOM_MENU_IDS.copyRelPath, label: '复制相对路径' });
          }
          if (target.fileUri) {
            copyMoreSub.push({ id: CUSTOM_MENU_IDS.copyUri, label: '复制 file:// 链接' });
          }
          augmented.push({ id: '__ag_reveal_copy_group__', label: '复制更多', type: 'submenu', submenu: copyMoreSub });
        }
        if (!menuContainsLabel(augmented, '打开方式') && !menuContainsLabel(augmented, 'open with')) {
          const openSub = [];
          if (target.exists) openSub.push({ id: CUSTOM_MENU_IDS.openDefault, label: '系统默认应用' });
          openSub.push({ id: CUSTOM_MENU_IDS.openFolder, label: target.isDir ? '打开文件夹' : '打开所在文件夹' });
          openSub.push({ id: CUSTOM_MENU_IDS.openTerminal, label: '在终端中打开所在文件夹' });
          augmented.push({ id: '__ag_reveal_open_group__', label: '打开方式', type: 'submenu', submenu: openSub });
        }
        const revealText = target.exists
          ? (navigator.platform && /mac/i.test(navigator.platform) ? '在访达中显示' : '在资源管理器中显示')
          : '打开所在文件夹（文件已不存在）';
        augmented.push({ id: CUSTOM_MENU_IDS.showInFolder, label: revealText });
      }
      return augmented;
    }

    async function handlePopupResponse(res) {
      if (!res || !res.shown) return;
      if (res.action === 'attach' && res.target) {
        attachToChatInput(res.target);
        return;
      }
      if (res.toast) {
        showToast(res.toast);
      }
    }

    // 路径 1：包装 ipcRenderer.invoke，注入原生 window:show-context-menu
    const wrappedInvoke = async function (channel, ...args) {
      if (
        channel === 'window:show-context-menu' &&
        Array.isArray(args[0]) &&
        pendingClick &&
        Date.now() - pendingClick.ts < 700
      ) {
        const clickCtx = pendingClick;
        clickCtx.handledByNativeMenu = true;
        const origItems = args[0];

        const hasReveal = menuContainsReveal(origItems);
        const hasCopyPath = menuContainsCopyPath(origItems);

        if (!hasReveal || !hasCopyPath) {
          try {
            const resolved = await rawInvoke('ag-reveal:resolve', clickCtx.extracted.payload);
            if (resolved && resolved.canReveal) {
              const augmented = buildMenuAugmentation(origItems, resolved, { hasReveal, hasCopyPath });
              const selectedId = await rawInvoke(channel, augmented, ...args.slice(1));
              const customActionMap = {
                [CUSTOM_MENU_IDS.attach]: 'attach',
                [CUSTOM_MENU_IDS.copyPath]: 'copy_path',
                [CUSTOM_MENU_IDS.copyName]: 'copy_name',
                [CUSTOM_MENU_IDS.copyRelPath]: 'copy_rel_path',
                [CUSTOM_MENU_IDS.copyUri]: 'copy_uri',
                [CUSTOM_MENU_IDS.openDefault]: 'open_default',
                [CUSTOM_MENU_IDS.openFolder]: 'open_folder',
                [CUSTOM_MENU_IDS.openTerminal]: 'open_terminal',
                [CUSTOM_MENU_IDS.showInFolder]: 'show_in_folder'
              };
              if (selectedId && customActionMap[selectedId]) {
                const act = customActionMap[selectedId];
                if (act === 'attach') {
                  attachToChatInput(resolved);
                } else {
                  const res = await rawInvoke('ag-reveal:execute', act, resolved);
                  if (res && (res.toast || res.error)) {
                    showToast(res.toast || res.error);
                  }
                }
                return null;
              }
              return selectedId;
            }
          } catch {
            // 回退原菜单
          }
        }
      }
      return rawInvoke(channel, ...args);
    };

    try {
      ipcRenderer.invoke = wrappedInvoke;
    } catch {}
    if (ipcRenderer.invoke !== wrappedInvoke) {
      try {
        Object.defineProperty(ipcRenderer, 'invoke', {
          value: wrappedInvoke,
          configurable: true,
          writable: true
        });
      } catch {}
    }

    function getVisibleDomMenus() {
      return Array.from(document.querySelectorAll('[role="menu"], [data-radix-menu-content]')).filter((el) => {
        const st = window.getComputedStyle(el);
        return st.display !== 'none' && st.visibility !== 'hidden' && el.getClientRects().length > 0;
      });
    }

    function createDomMenuItem(sampleItem, label, onClick) {
      const item = document.createElement('div');
      item.setAttribute('role', 'menuitem');
      item.setAttribute('tabindex', '-1');
      item.setAttribute('data-ag-reveal-item', '1');
      if (sampleItem && sampleItem.className) {
        item.className = sampleItem.className;
      } else {
        item.style.cssText = 'padding:6px 12px;font-size:13px;cursor:pointer;border-radius:5px;user-select:none;';
      }
      item.textContent = label;
      item.addEventListener('click', (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        onClick();
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      });
      return item;
    }

    function appendDomMenuFileItems(menuEl, target) {
      if (!menuEl || !menuEl.isConnected || menuEl.querySelector('[data-ag-reveal-item="1"]')) return;
      const txt = (menuEl.textContent || '').toLowerCase();
      const hasReveal = txt.includes('资源管理器') || txt.includes('explorer') || txt.includes('finder');
      const hasCopyPath = txt.includes('复制文件路径') || txt.includes('复制路径') || txt.includes('copy file path') || txt.includes('copy path');
      if (hasReveal && hasCopyPath) return;

      const sampleItem = menuEl.querySelector('[role="menuitem"]');
      const sep = document.createElement('div');
      sep.setAttribute('role', 'separator');
      sep.setAttribute('data-ag-reveal-item', '1');
      sep.style.cssText = 'height:1px;margin:4px 6px;background:color-mix(in srgb, currentColor 14%, transparent);';
      menuEl.appendChild(sep);

      if (!hasCopyPath) {
        menuEl.appendChild(
          createDomMenuItem(sampleItem, '复制文件路径', () => {
            void rawInvoke('ag-reveal:execute', 'copy_path', target).then((res) => {
              if (res && (res.toast || res.error)) showToast(res.toast || res.error);
            });
          })
        );
      }

      if (!hasReveal) {
        const revealLabelText = target.exists ? '在资源管理器中显示' : '打开所在文件夹（文件已不存在）';
        menuEl.appendChild(
          createDomMenuItem(sampleItem, revealLabelText, () => {
            void rawInvoke('ag-reveal:execute', 'show_in_folder', target).then((res) => {
              if (res && (res.toast || res.error)) showToast(res.toast || res.error);
            });
          })
        );
      }
    }

    // 捕获阶段：记录右键候选快照
    window.addEventListener(
      'contextmenu',
      (event) => {
        const extracted = extractRightClickPayload(event);
        if (!extracted) {
          pendingClick = null;
          return;
        }
        pendingClick = {
          ts: Date.now(),
          extracted,
          handledByNativeMenu: false,
          existingMenus: new Set(getVisibleDomMenus())
        };
      },
      true
    );

    // 气泡阶段：路径 2（未拦截原生弹出）& 路径 3（Radix DOM 菜单或无菜单防遗漏）
    window.addEventListener(
      'contextmenu',
      async (event) => {
        const clickCtx = pendingClick;
        if (!clickCtx || clickCtx.handledByNativeMenu) return;

        const { extracted } = clickCtx;
        if (!event.defaultPrevented) {
          // 仅对明确文件特征（链接、路径属性、绝对/相对路径、可识别文件扩展名且非输入框空区）抢先阻止 Chromium 默认菜单
          if (!extracted.hasExplicitFileUri && (!extracted.hasStrongCandidate || extracted.editable)) {
            return;
          }
          event.preventDefault();
          clickCtx.handledByNativeMenu = true;
          const res = await rawInvoke('ag-reveal:popup-menu', extracted.payload);
          await handlePopupResponse(res);
          return;
        }

        // event.defaultPrevented 为 true：延迟检查是否由路径 1 接管或由 Radix DOM 菜单接管
        setTimeout(async () => {
          if (clickCtx.handledByNativeMenu) return;
          const newMenus = getVisibleDomMenus().filter((el) => !clickCtx.existingMenus.has(el));
          try {
            const resolved = await rawInvoke('ag-reveal:resolve', extracted.payload);
            if (!resolved || !resolved.canReveal) return;
            if (clickCtx.handledByNativeMenu) return;
            if (newMenus.length > 0 && newMenus[0].isConnected) {
              appendDomMenuFileItems(newMenus[0], resolved);
            } else if (extracted.hasExplicitFileUri || extracted.hasStrongCandidate) {
              const res = await rawInvoke('ag-reveal:popup-menu', extracted.payload);
              await handlePopupResponse(res);
            }
          } catch {}
        }, 45);
      },
      false
    );
  } catch (err) {
    try {
      console.error('[ag-reveal-in-explorer] preload init error:', err);
    } catch {}
  }
})();
// ===== AG_REVEAL_EXPLORER_END =====
