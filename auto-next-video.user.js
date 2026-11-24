// ==UserScript==
// @name         自动连播 · 视频播完自动下一个
// @namespace    dsh.auto-next
// @version      1.8.0
// @description  视频播放结束后自动播放下一个：支持右侧列表选片、B站 / YouTube、通用「下一集」按钮，找不到可自定义选择器
// @author       you
// @match        *://*/*
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @grant        GM_addStyle
// @run-at       document-idle
// @license      MIT
// ==/UserScript==

(function () {
  'use strict';

  if (window.__anvLoaded) return;
  window.__anvLoaded = true;

  /* ===================== 配置 ===================== */

  const DEFAULT_CFG = {
    enabled: true,          // 总开关
    delay: 3,               // 结束后等几秒再切（0 = 立刻）
    forceAutoplay: true,    // 切到新页面后尝试自动播放
    showFab: true,          // 显示右侧悬浮按钮
    listMode: true,         // 没有「下一集」按钮时，从右侧列表挑下一个
    skipDone: true,         // 跳过右侧列表里标了「已完成」的项
    customSelectors: {},    // { "域名": "「下一个」按钮的选择器" }
    customLists: {}         // { "域名": "列表项的选择器" }
  };

  const AUTO_FLAG = 'anv:autonext';
  const LAST_KEY = 'anv:last';
  const PTR_KEY = 'anv:menuptr';
  const HOST = location.hostname;

  function loadCfg() {
    let saved = null;
    try {
      if (typeof GM_getValue === 'function') saved = GM_getValue('cfg', null);
      else saved = JSON.parse(localStorage.getItem('anv:cfg') || 'null');
    } catch (e) { saved = null; }
    const base = Object.assign({}, DEFAULT_CFG, saved || {});
    base.customSelectors = Object.assign({}, (saved && saved.customSelectors) || {});
    base.customLists = Object.assign({}, (saved && saved.customLists) || {});
    return base;
  }

  function saveCfg() {
    try {
      if (typeof GM_setValue === 'function') GM_setValue('cfg', cfg);
      else localStorage.setItem('anv:cfg', JSON.stringify(cfg));
    } catch (e) { /* 存不了就算了 */ }
  }

  const cfg = loadCfg();

  /* ===================== 站点适配 ===================== */

  const SITE = /(^|\.)bilibili\.com$/.test(HOST) ? 'bilibili'
    : /(^|\.)youtube\.com$/.test(HOST) ? 'youtube'
    : /(^|\.)douyin\.com$/.test(HOST) ? 'douyin'
    : /(^|\.)ixigua\.com$/.test(HOST) ? 'ixigua'
    : 'generic';

  const SITE_SELECTORS = {
    bilibili: [
      '.bpx-player-ctrl-next',
      '.bilibili-player-video-btn-next',
      '.squirtle-video-next'
    ],
    youtube: ['.ytp-next-button'],
    douyin: [],
    ixigua: [],
    generic: []
  };

  /* 强匹配：明确说“下一集/下一课/next episode” */
  const RE_STRONG = /下一\s*[集個个课課节節期首回话話章篇]|next\s*(episode|video|part|lesson|lecture|clip)|\bup\s*next\b/i;
  /* 弱匹配：只有“下一个 / next”这种短标签 */
  const RE_WEAK = /^(下一|next|往下)[\s>»…·\-]*$/i;

  /* ===================== 工具 ===================== */

  function safeQuery(doc, sel) {
    try { return doc.querySelectorAll(sel); } catch (e) { return []; }
  }

  function firstVisible(list) {
    for (let i = 0; i < list.length; i++) {
      if (visible(list[i])) return list[i];
    }
    return null;
  }

  function viewOf(el) {
    const doc = el && el.ownerDocument;
    return (doc && doc.defaultView) || window;
  }

  function visible(el) {
    if (!el || !el.getBoundingClientRect) return false;
    const r = el.getBoundingClientRect();
    if (r.width < 6 || r.height < 6) return false;
    const st = viewOf(el).getComputedStyle(el);
    if (st.display === 'none' || st.visibility === 'hidden') return false;
    if (parseFloat(st.opacity) < 0.05) return false;
    return true;
  }

  /* 页面上可能塞了好几个 video（广告、预览、悬浮窗），取面积最大的当“主视频” */
  function mainVideo() {
    const vids = document.querySelectorAll('video');
    let best = null;
    let bestArea = 0;
    for (let i = 0; i < vids.length; i++) {
      const r = vids[i].getBoundingClientRect();
      const area = Math.max(0, r.width) * Math.max(0, r.height);
      if (area > bestArea) { bestArea = area; best = vids[i]; }
    }
    if (best && bestArea > 2000) return best;
    return vids.length === 1 ? vids[0] : best;
  }

  function isMainVideo(v) {
    const vids = document.querySelectorAll('video');
    if (vids.length <= 1) return true;
    return mainVideo() === v;
  }

  function clickEl(el) {
    try { el.scrollIntoView({ block: 'center', inline: 'center' }); } catch (e) { /* ignore */ }
    const opt = { bubbles: true, cancelable: true, view: window };
    try {
      if (typeof PointerEvent === 'function') {
        el.dispatchEvent(new PointerEvent('pointerdown', opt));
        el.dispatchEvent(new PointerEvent('pointerup', opt));
      }
      el.dispatchEvent(new MouseEvent('mousedown', opt));
      el.dispatchEvent(new MouseEvent('mouseup', opt));
      el.click();
    } catch (e) {
      try { el.click(); } catch (e2) { /* ignore */ }
    }
  }

  function markAutoNext() {
    try { sessionStorage.setItem(AUTO_FLAG, String(Date.now())); } catch (e) { /* ignore */ }
  }

  /* 最近干了啥，诊断的时候一起打出来 */
  const actionLog = [];

  function logAct(msg) {
    try {
      const d = new Date();
      const pad = function (n) { return (n < 10 ? '0' : '') + n; };
      actionLog.push(pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds()) + ' ' + msg);
      if (actionLog.length > 12) actionLog.shift();
    } catch (e) { /* ignore */ }
  }

  /* ===================== 找「下一个」按钮 ===================== */

  function scoreEl(el) {
    if (!el || el.nodeType !== 1) return -1;
    if (el.closest('[data-anv-ui]')) return -1;

    const tag = el.tagName;
    if (tag === 'VIDEO' || tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return -1;

    const text = (el.textContent || '').trim().replace(/\s+/g, ' ');
    if (text.length > 36) return -1;

    const aria = (el.getAttribute('aria-label') || '') + ' ' + (el.getAttribute('title') || '');
    const cls = (typeof el.className === 'string' ? el.className : '') + ' ' + (el.id || '');

    let s = 0;
    if (RE_STRONG.test(text)) s += 12;
    else if (RE_WEAK.test(text)) s += 7;
    if (RE_STRONG.test(aria) || /next/i.test(aria)) s += 5;
    if (/(^|[\s_-])next([\s_-]|$)/i.test(cls)) s += 8;
    if (s <= 0) return -1;                       // 先用便宜的判断筛掉一大片

    if (!visible(el)) return -1;
    if (el.hasAttribute('disabled') || el.getAttribute('aria-disabled') === 'true') return -1;

    if (tag !== 'A' && tag !== 'BUTTON' && el.getAttribute('role') !== 'button' && !el.onclick) s -= 3;
    if (el.closest('[class*="player"],[class*="video"],[class*="playlist"],[class*="episode"],[class*="course"],[class*="lesson"]')) s += 3;
    if (tag === 'A' && el.getAttribute('href')) s += 1;

    return s;
  }

  function findButtonIn(doc) {
    const custom = cfg.customSelectors[HOST];
    if (custom) {
      const el = firstVisible(safeQuery(doc, custom));
      if (el) return el;
    }

    const list = SITE_SELECTORS[SITE] || [];
    for (let i = 0; i < list.length; i++) {
      const el = firstVisible(safeQuery(doc, list[i]));
      if (el) return el;
    }

    // 全场打分
    const nodes = doc.querySelectorAll('a, button, [role="button"], [onclick]');
    let best = null;
    let bestScore = 0;
    for (let i = 0; i < nodes.length; i++) {
      const s = scoreEl(nodes[i]);
      if (s > bestScore) { bestScore = s; best = nodes[i]; }
    }
    return bestScore >= 6 ? best : null;
  }

  /* 播放器在 iframe 里时，按钮可能在外层页面 */
  function findButtonAnywhere() {
    let el = findButtonIn(document);
    if (el) return el;
    if (window !== window.top) {
      try {
        const topDoc = window.top.document;
        if (topDoc) el = findButtonIn(topDoc);
      } catch (e) { /* 跨域，认了 */ }
    }
    return el;
  }

  /* ===================== 右侧列表连播 ===================== */

  const LIST_HINT = /playlist|play-list|episode|chapter|lesson|catalog|series|video-list|chapter-list|lesson-list|sidebar|aside|menu|index-list|(^|[\s_-])list($|[\s_-])/i;

  /* 把所有链接按先父、再祖父、再曾祖父归组：ul > li > a 这类结构都能抓住 */
  function collectAnchorGroups(doc) {
    const groups = new Map();
    const anchors = doc.querySelectorAll('a[href]');
    for (let i = 0; i < anchors.length; i++) {
      const a = anchors[i];
      if (a.closest && a.closest('[data-anv-ui]')) continue;
      let n = a.parentElement;
      for (let d = 0; n && d < 3; d++, n = n.parentElement) {
        if (!groups.has(n)) groups.set(n, []);
        groups.get(n).push(a);
      }
    }
    return groups;
  }

  /* 不看 class、不看标签名，只看形状：一列竖着的、高度差不多的东西。兜底用 */
  function geometricCandidates(doc) {
    const out = [];
    const body = doc && doc.body;
    if (!body) return out;
    const winW = (doc.defaultView || window).innerWidth || 800;
    const nodes = body.querySelectorAll('div,ul,ol,section,aside,nav,dl');
    for (let i = 0; i < nodes.length; i++) {
      const c = nodes[i];
      if (c.closest && c.closest('[data-anv-ui]')) continue;
      const kids = c.children;
      if (!kids || kids.length < 3 || kids.length > 200) continue;

      const r = c.getBoundingClientRect();
      if (r.height < 150 || r.width < 80) continue;
      if (r.width > winW * 0.85) continue;                              // 整页宽的不是侧栏
      if (!(r.left >= winW * 0.15 || r.width <= winW * 0.35)) continue; // 靠右，或者本身是窄条

      const items = [];
      for (let k = 0; k < kids.length; k++) {
        const rr = kids[k].getBoundingClientRect();
        if (rr.width < 30 || rr.height < 10) continue;
        items.push(kids[k]);
      }
      if (items.length < 3) continue;

      let prevTop = -Infinity;
      let vertical = true;
      let hMin = Infinity;
      let hMax = 0;
      const stride = Math.max(1, Math.floor(items.length / 8));
      for (let k = 0; k < items.length; k += stride) {
        const rr = items[k].getBoundingClientRect();
        if (rr.top <= prevTop) vertical = false;
        prevTop = rr.top;
        if (rr.height < hMin) hMin = rr.height;
        if (rr.height > hMax) hMax = rr.height;
      }
      if (!vertical) continue;
      if (hMax > hMin * 2.4) continue;

      const cls = (typeof c.className === 'string' ? c.className : '') + ' ' + (c.id || '');
      let s = 0;
      if (r.left > winW * 0.55) s += 6;
      else if (r.left > winW * 0.3) s += 4;
      else s += 1;
      if (r.width < winW * 0.45) s += 3;
      if (items.length >= 5) s += 2;
      if (LIST_HINT.test(cls)) s += 3;
      if (r.height > 260) s += 1;

      let clickable = 0;
      for (let k = 0; k < items.length; k++) {
        const x = items[k];
        if (x.tagName === 'A' || (x.querySelector && x.querySelector('a[href]')) ||
            x.onclick || x.getAttribute('role') === 'button' ||
            x.hasAttribute('data-id') || x.hasAttribute('data-index')) clickable++;
      }
      if (clickable >= items.length * 0.6) s += 2;

      if (s >= 10) out.push({ container: c, items: items, score: s });
    }
    return out;
  }

  function cssPath(el, depth) {
    const parts = [];
    let n = el;
    for (let d = 0; d < (depth || 3) && n && n.nodeType === 1; d++) {
      let s = String(n.tagName || '').toLowerCase();
      if (n.id) { parts.unshift(s + '#' + n.id); break; }
      const cls = (typeof n.className === 'string' ? n.className : '').trim().split(/\s+/)[0];
      if (cls) s += '.' + cls;
      parts.unshift(s);
      n = n.parentElement;
    }
    return parts.join(' > ') || '?';
  }

  function anchorOf(item) {
    if (!item) return null;
    if (item.tagName === 'A') return item;
    return (item.querySelector && item.querySelector('a[href]')) || null;
  }

  function clickableOf(item) {
    return anchorOf(item) || item;
  }

  function absUrl(href) {
    try { return new URL(href, location.href).href; } catch (e) { return ''; }
  }

  function sameTarget(a, b) {
    const ua = absUrl(a), ub = absUrl(b);
    return !!ua && !!ub && ua === ub;
  }

  function hrefMatchesCurrent(href) {
    if (!href) return false;
    let a, b;
    try {
      a = new URL(href, location.href);
      b = new URL(location.href);
    } catch (e) { return false; }
    if (a.origin !== b.origin) return false;
    if (a.hash && a.hash === b.hash && a.pathname === b.pathname) return true;
    if (a.pathname !== b.pathname) return false;
    if (a.search === b.search) return true;
    const keys = ['p', 'ep', 'episode', 'lesson', 'chapter', 'id', 'vid', 'index'];
    for (let i = 0; i < keys.length; i++) {
      const x = a.searchParams.get(keys[i]);
      const y = b.searchParams.get(keys[i]);
      if (x && y) return x === y;
    }
    return false;
  }

  /* 当前正在播的是哪一项：class / aria / 地址 / 上次记录 */
  function isActiveItem(el) {
    let n = el;
    for (let d = 0; n && n.nodeType === 1 && d < 3; d++, n = n.parentElement) {
      const cls = typeof n.className === 'string' ? n.className : '';
      if (/(^|[\s_-])(active|current|playing|selected|cur|now|is-active|now-playing|currentitem|playing-item|last_unfinished)($|[\s_-])/i.test(cls)) return true;
      if (n.getAttribute) {
        if (n.getAttribute('aria-current') === 'true' || n.getAttribute('aria-selected') === 'true') return true;
        if (n.getAttribute('data-active') === 'true') return true;
      }
    }
    return false;
  }

  function itemText(el) {
    return (el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 80);
  }

  /* 这一项是不是「已完成」：文字、勾勾、或者里面的图标 class */
  const DONE_CLASS = /(^|[\s_-])(complete|completed|checked|check|done|finished|finish|success|passed|ok)($|[\s_-])/i;

  function isDoneItem(el) {
    if (!el) return false;

    const txt = el.textContent || '';
    if (/已完成|已学完|已看完|已学习|已通过|已结束/.test(txt)) return true;
    if (/[✓✔✅]/.test(txt)) return true;

    // 标记常常就挂在这一项自己的 class 上，比如 "video-item finished"
    const own = typeof el.className === 'string'
      ? el.className
      : (el.className && el.className.baseVal) || '';
    if (own && DONE_CLASS.test(own)) return true;

    const aria = (el.getAttribute && (el.getAttribute('aria-label') || el.getAttribute('title'))) || '';
    if (/完成|已学/.test(aria)) return true;

    const kids = el.querySelectorAll('i, span, em, img, svg, use, [class]');
    for (let i = 0; i < kids.length; i++) {
      const k = kids[i];
      const cls = typeof k.className === 'string'
        ? k.className
        : (k.className && k.className.baseVal) || '';
      if (DONE_CLASS.test(cls)) return true;
      if (k.getAttribute && /完成|已学/.test(k.getAttribute('title') || '')) return true;
    }
    return false;
  }

  function rememberPlayed(item, index) {
    try {
      const a = anchorOf(item);
      sessionStorage.setItem(LAST_KEY, JSON.stringify({
        host: HOST,
        href: a ? (a.getAttribute('href') || '') : '',
        text: itemText(item),
        index: index,
        ts: Date.now()
      }));
    } catch (e) { /* ignore */ }
  }

  function readLastPlayed() {
    try {
      const raw = sessionStorage.getItem(LAST_KEY);
      if (!raw) return null;
      const o = JSON.parse(raw);
      if (!o || o.host !== HOST) return null;
      if (Date.now() - (o.ts || 0) > 6 * 3600 * 1000) return null;
      return o;
    } catch (e) { return null; }
  }

  function evaluateList(container, items) {
    if (!items || items.length < 3 || items.length > 400) return null;
    if (!visible(container)) return null;

    const winW = viewOf(container).innerWidth || window.innerWidth || 800;
    const r = container.getBoundingClientRect();
    if (r.width < 60 || r.height < 60) return null;

    const cls = (typeof container.className === 'string' ? container.className : '') + ' ' + (container.id || '');

    let s = 0;
    if (r.left > winW * 0.55) s += 6;          // 右半边
    else if (r.left > winW * 0.3) s += 3;      // 偏右
    if (r.width < winW * 0.7) s += 2;          // 不是整页宽
    if (LIST_HINT.test(cls)) s += 5;
    s += Math.min(4, items.length / 4);

    // 竖着排的吗
    const tops = [];
    const step = Math.max(1, Math.floor(items.length / 6));
    for (let i = 0; i < items.length; i += step) {
      const rr = items[i].getBoundingClientRect();
      if (rr.height < 8) continue;
      tops.push(rr.top);
    }
    if (tops.length >= 2) {
      let inc = true;
      for (let i = 1; i < tops.length; i++) if (tops[i] <= tops[i - 1]) inc = false;
      if (inc) s += 3;
    }

    return s >= 9 ? { container: container, items: items, score: s } : null;
  }

  function detectPlaylistIn(doc) {
    let best = null;
    const consider = function (res) {
      if (res && (!best || res.score > best.score)) best = res;
    };

    collectAnchorGroups(doc).forEach(function (items, container) {
      consider(evaluateList(container, items));
    });

    geometricCandidates(doc).forEach(consider);

    const hinted = doc.querySelectorAll('[class*="episode"],[class*="chapter"],[class*="lesson"],[class*="playlist"],[class*="catalog"],[class*="video-list"],[class*="play-list"],[class*="course-list"]');
    let n = 0;
    for (let i = 0; i < hinted.length && n < 40; i++) {
      const c = hinted[i];
      if (c.closest && c.closest('[data-anv-ui]')) continue;
      const items = Array.prototype.filter.call(c.children, function (x) {
        return x.nodeType === 1 && visible(x);
      });
      if (items.length < 3) continue;
      n++;
      consider(evaluateList(c, items));
    }

    return best;
  }

  function detectPlaylist() {
    let best = detectPlaylistIn(document);
    if (window !== window.top) {
      try {
        const topDoc = window.top.document;
        if (topDoc && topDoc !== document) {
          const t = detectPlaylistIn(topDoc);
          if (t && (!best || t.score > best.score)) best = t;
        }
      } catch (e) { /* 跨域，认了 */ }
    }
    return best;
  }

  /* ---------- 嵌套菜单（Element UI / antd 那种） ---------- */

  const MENU_ITEM_SEL = '[role="menuitem"], li[class*="menu-item"], [class*="menu_item"], .el-menu-item, [class*="video-item"], [class*="video_item"]';

  /* 只要叶子项：自己里面不再套菜单项的才算一个视频 */
  function leafMenuItems(root) {
    const all = (root || document).querySelectorAll(MENU_ITEM_SEL);
    const out = [];
    for (let i = 0; i < all.length; i++) {
      const el = all[i];
      if (el.closest && el.closest('[data-anv-ui]')) continue;
      if (el.querySelector(MENU_ITEM_SEL)) continue;
      out.push(el);
    }
    return out;
  }

  /* 这个菜单项属于哪一棵菜单：往上找最高的 ul / role=menu / class 带 menu 的祖先 */
  function menuRootOf(el) {
    let best = null;
    let n = el.parentElement;
    while (n && n !== document.documentElement) {
      const cls = typeof n.className === 'string' ? n.className : '';
      if (n.tagName === 'UL' || n.tagName === 'OL' ||
          (n.getAttribute && n.getAttribute('role') === 'menu') ||
          /(^|[\s_-])(menu|list)($|[\s_-])/i.test(cls)) {
        best = n;
      }
      n = n.parentElement;
    }
    return best;
  }

  /* 记住我们点到第几项了。有的站点不回写 is-active，不记就会一直点同一项。 */
  function pageKey() {
    try {
      const u = new URL(location.href);
      const cid = u.searchParams.get('course_id') || u.searchParams.get('courseId') || '';
      return cid ? u.origin + u.pathname + '#c' + cid : u.origin + u.pathname + u.search;
    } catch (e) { return location.href; }
  }

  let memPtr = -1;

  function loadPointer() {
    if (memPtr >= 0) return memPtr;
    try {
      const raw = sessionStorage.getItem(PTR_KEY);
      if (!raw) return -1;
      const o = JSON.parse(raw);
      if (!o || o.host !== HOST) return -1;
      if (o.key !== pageKey()) return -1;
      if (Date.now() - (o.at || 0) > 4 * 3600 * 1000) return -1;
      return typeof o.idx === 'number' ? o.idx : -1;
    } catch (e) { return -1; }
  }

  function savePointer(idx) {
    memPtr = idx;
    try {
      if (idx < 0) { sessionStorage.removeItem(PTR_KEY); return; }
      sessionStorage.setItem(PTR_KEY, JSON.stringify({
        host: HOST, key: pageKey(), idx: idx, at: Date.now()
      }));
    } catch (e) { /* ignore */ }
  }

  /* 菜单项文案里常带时长，比如「第3讲 现代国防 (00:20:22)」，拿来和视频实际时长对 */
  function parseDurationSec(text) {
    const m = /[（(]\s*(\d{1,3})\s*[:：]\s*([0-5]\d)(?:\s*[:：]\s*([0-5]\d))?\s*[)）]/.exec(text || '');
    if (!m) return -1;
    if (m[3] != null) return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
    return Number(m[1]) * 60 + Number(m[2]);
  }

  /* 用「正在播的这个视频多长」反推它在列表里是第几项。站点乱标高亮时靠这个 */
  function durationMatch(items) {
    const v = mainVideo();
    if (!v) return { idx: -1, why: '页面上没有 video' };
    if (!isFinite(v.duration) || v.duration <= 0) {
      return { idx: -1, why: '视频时长还没读到（就绪=' + v.readyState + '）' };
    }

    let parsed = 0;
    let b1 = -1;
    let d1 = 1e9;
    let d2 = 1e9;
    for (let i = 0; i < items.length; i++) {
      const s = parseDurationSec(itemText(items[i]));
      if (s <= 0) continue;
      parsed++;
      const diff = Math.abs(s - v.duration);
      if (diff < d1) { d2 = d1; d1 = diff; b1 = i; }
      else if (diff < d2) { d2 = diff; }
    }
    if (!parsed) return { idx: -1, why: '列表项里没写时长' };
    if (b1 >= 0 && d1 <= 4) {
      if (d2 <= 10) return { idx: -1, why: '有两项时长撞车，不敢猜' };
      return { idx: b1, why: '' };
    }
    return { idx: -1, why: '最接近的差 ' + Math.round(d1) + ' 秒' };
  }

  function matchByDuration(items) {
    return durationMatch(items).idx;
  }

  function menuState() {
    const all = leafMenuItems(document);
    if (all.length < 3) return null;
    let idx = -1;
    for (let i = 0; i < all.length; i++) {
      if (isActiveItem(all[i])) { idx = i; break; }
    }
    return { items: all, idx: idx };
  }

  /* 整个菜单按 DOM 顺序拍平，当前项的下一个就是“下一集”，跨章节也能接上 */
  function findMenuNext() {
    const st = menuState();
    if (!st || st.idx < 0) return null;

    // 站点不回写 is-active 时，以我们上次点到的地方为准
    const base0 = Math.max(st.idx, loadPointer());
    if (base0 < 0) return null;

    // 视频时长最可靠：站点高亮乱标的时候，它是唯一实锤
    const byDur = matchByDuration(st.items);
    const base = byDur >= 0 ? byDur : base0;
    if (byDur >= 0) logAct('按时长定位到第 ' + (byDur + 1) + ' 项');
    if (base < 0) return null;

    for (let i = base + 1; i < st.items.length; i++) {
      const cand = st.items[i];
      const a = menuRootOf(st.items[st.idx]);
      const b = menuRootOf(cand);
      if (a && b && a !== b) break;                      // 下一棵菜单了，收手
      if (cfg.skipDone !== false && isDoneItem(cand)) {
        logAct('跳过已完成 第 ' + (i + 1) + ' 项 ' + itemText(cand).slice(0, 14));
        continue;
      }
      return {
        el: cand,
        item: cand,
        index: i,
        total: st.items.length,
        menu: true,
        prepare: visible(cand) ? null : visibleHolder(cand)
      };
    }
    return { end: true };
  }

  /* 这个列表项被折叠在哪个子菜单里 */
  function visibleHolder(el) {
    let n = el.parentElement;
    while (n && n !== document.body) {
      if (n.tagName === 'LI' && visible(n)) return n;
      n = n.parentElement;
    }
    return null;
  }

  /* 找列表里的“下一个”，返回 {el} / {end:true} / null */
  function findPlaylistNext() {
    if (!cfg.listMode) return null;

    const custom = cfg.customLists[HOST];
    let items;
    let container = null;

    if (custom) {
      items = Array.prototype.filter.call(safeQuery(document, custom), visible);
      if (items.length < 2) return null;
    } else {
      const m = findMenuNext();
      if (m) return m;
      const list = detectPlaylist();
      if (!list) return null;
      items = list.items;
      container = list.container;
    }

    let idx = -1;
    for (let i = 0; i < items.length; i++) {
      if (isActiveItem(items[i])) { idx = i; break; }
    }
    if (idx < 0) {
      for (let i = 0; i < items.length; i++) {
        const a = anchorOf(items[i]);
        if (a && hrefMatchesCurrent(a.getAttribute('href'))) { idx = i; break; }
      }
    }
    if (idx < 0) {
      const last = readLastPlayed();
      if (last) {
        for (let i = 0; i < items.length; i++) {
          const a = anchorOf(items[i]);
          const href = a ? a.getAttribute('href') : '';
          if ((last.href && href && sameTarget(href, last.href)) || (last.text && itemText(items[i]) === last.text)) {
            idx = i;
            break;
          }
        }
      }
    }
    if (idx < 0) {
      const last = readLastPlayed();
      if (last && typeof last.index === 'number' && last.index < items.length) idx = last.index;
    }
    if (idx < 0) return null;

    // 列表模式也一样，跳过标了已完成的
    let n = idx + 1;
    while (n < items.length && cfg.skipDone !== false && isDoneItem(items[n])) {
      logAct('跳过已完成 第 ' + (n + 1) + ' 项 ' + itemText(items[n]).slice(0, 14));
      n++;
    }
    if (n >= items.length) return { end: true };

    return {
      el: clickableOf(items[n]),
      item: items[n],
      index: n,
      total: items.length,
      container: container
    };
  }

  function playlistInfo() {
    if (!cfg.listMode) return '列表连播已关闭';
    const custom = cfg.customLists[HOST];
    let items;
    if (custom) {
      items = Array.prototype.filter.call(safeQuery(document, custom), visible);
    } else {
      const mi = menuState();
      if (mi) {
        const p = loadPointer();
        const dm = durationMatch(mi.items);
        let doneN = 0;
        for (let i = 0; i < mi.items.length; i++) if (isDoneItem(mi.items[i])) doneN++;
        return '菜单 ' + mi.items.length + ' 项' +
               (mi.idx >= 0 ? '，高亮第 ' + (mi.idx + 1) + ' 项' : '，没认出高亮') +
               (dm.idx >= 0 ? '，按时长第 ' + (dm.idx + 1) + ' 项' : '，时长对不上：' + dm.why) +
               '，已完成 ' + doneN + ' 项' +
               (p >= 0 ? '，指针第 ' + (p + 1) + ' 项' : '') +
               (cfg.skipDone !== false ? '' : '（跳过已关闭）');
      }
      const list = detectPlaylist();
      if (!list) return '没检测到列表，点「诊断」看看页面结构';
      items = list.items;
    }
    if (!items || items.length < 2) return '没检测到列表项';
    let idx = -1;
    for (let i = 0; i < items.length; i++) if (isActiveItem(items[i])) { idx = i; break; }
    return '列表 ' + items.length + ' 项' + (idx >= 0 ? '，当前第 ' + (idx + 1) + ' 项' : '，没认出当前项');
  }

  /* 把页面里的候选列表打印出来，方便贴给我看 */
  function diagnose() {
    const lines = [];
    lines.push('ANV ' + location.host + '  ' + location.href.slice(0, 140));
    lines.push('video=' + document.querySelectorAll('video').length +
               '  视口=' + innerWidth + 'x' + innerHeight +
               '  链接=' + document.querySelectorAll('a[href]').length +
               '  li=' + document.querySelectorAll('li').length);

    const cands = [];
    collectAnchorGroups(document).forEach(function (items, c) {
      const res = evaluateList(c, items);
      if (res) cands.push(res);
    });
    geometricCandidates(document).forEach(function (r) { cands.push(r); });
    cands.sort(function (a, b) { return b.score - a.score; });

    const mi = menuState();
    const dm = mi ? durationMatch(mi.items) : { idx: -1, why: '无菜单' };
    lines.push('菜单=' + (mi ? mi.items.length + ' 项, active=' + mi.idx : '无') +
               '  指针=' + (loadPointer() >= 0 ? loadPointer() + 1 : '无') +
               '  按时长=' + (dm.idx >= 0 ? (dm.idx + 1) : ('对不上：' + dm.why)));
    if (mi) {
      const n = Math.min(mi.items.length, 20);
      lines.push('菜单项（✓=判定已完成，*=当前，只有前 ' + n + ' 项）:');
      for (let i = 0; i < n; i++) {
        lines.push('  ' + (i === mi.idx ? '*' : ' ') + (i + 1) + ' ' +
                   (isDoneItem(mi.items[i]) ? '✓' : '·') + ' ' + itemText(mi.items[i]).slice(0, 26));
      }
    }
    const vm = mainVideo();
    if (vm) {
      lines.push(videoStatusText() + '  src=' + String(vm.currentSrc || vm.src || '').slice(0, 70));
    }
    lines.push('候选列表=' + cands.length);
    cands.slice(0, 6).forEach(function (r, i) {
      const rc = r.container.getBoundingClientRect();
      let act = -1;
      for (let k = 0; k < r.items.length; k++) if (isActiveItem(r.items[k])) { act = k; break; }
      lines.push(' ' + (i + 1) + ') ' + cssPath(r.container, 3) +
        ' | 项=' + r.items.length +
        ' | 分=' + r.score +
        ' | 位置=' + Math.round(rc.left) + ',' + Math.round(rc.top) +
        ' | 尺寸=' + Math.round(rc.width) + 'x' + Math.round(rc.height) +
        ' | active=' + act);
    });

    if (actionLog.length) {
      lines.push('最近动作:');
      for (let i = 0; i < actionLog.length; i++) lines.push('  ' + actionLog[i]);
    }
    return lines.join('\n');
  }

  function copyText(text) {
    try { console.log(text); } catch (e) { /* ignore */ }
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).catch(function () { fallbackCopy(text); });
        return;
      }
    } catch (e) { /* ignore */ }
    fallbackCopy(text);
  }

  function fallbackCopy(text) {
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.left = '-9999px';
      (document.body || document.documentElement).appendChild(ta);
      ta.select();
      document.execCommand('copy');
      ta.parentNode.removeChild(ta);
    } catch (e) { /* ignore */ }
  }

  /* ===================== 决定点哪儿 ===================== */

  function locateTarget() {
    // 1. 用户自定义的按钮
    const custom = cfg.customSelectors[HOST];
    if (custom) {
      const el = firstVisible(safeQuery(document, custom));
      if (el) return { el: el };
    }

    // 2. 站点适配的“下一集”按钮
    const list = SITE_SELECTORS[SITE] || [];
    for (let i = 0; i < list.length; i++) {
      const el = firstVisible(safeQuery(document, list[i]));
      if (el) return { el: el };
    }

    // 3. 右侧列表的下一项
    const p = findPlaylistNext();
    if (p) {
      if (p.end) return { end: true };
      return { el: p.el, playlist: p };
    }

    // 4. 全页面找“下一集”按钮
    const btn = findButtonAnywhere();
    if (btn) return { el: btn };

    return null;
  }

  /* ===================== 倒计时 + 切换 ===================== */

  let cdState = null;   // { timer, box, snap }

  function startCountdown(video) {
    cancelCountdown();
    if (!cfg.enabled) return;

    const snap = {
      href: location.href,
      src: video.currentSrc || video.src || ''
    };

    const wait = Math.max(0, Math.round(Number(cfg.delay) || 0));
    if (wait === 0) { goNext(snap); return; }

    buildUI();
    const box = document.createElement('div');
    box.className = 'anv-cd';
    box.setAttribute('data-anv-ui', '');
    box.innerHTML =
      '<div class="anv-cd-text">' + wait + ' 秒后播放下一集</div>' +
      '<div class="anv-bar"><i style="transition-duration:' + wait + 's"></i></div>' +
      '<div class="anv-cd-row">' +
        '<button type="button" data-act="cancel">取消</button>' +
        '<button type="button" data-act="now">立即</button>' +
      '</div>';
    document.documentElement.appendChild(box);

    const bar = box.querySelector('i');
    requestAnimationFrame(function () { bar.style.width = '0%'; });

    box.addEventListener('click', function (e) {
      const act = e.target && e.target.getAttribute('data-act');
      if (act === 'cancel') { cancelCountdown(); toast('已取消'); }
      if (act === 'now') { const s = cdState && cdState.snap; cancelCountdown(); goNext(s); }
    });

    let left = wait;
    const timer = setInterval(function () {
      left -= 1;
      const t = box.querySelector('.anv-cd-text');
      if (left > 0) {
        if (t) t.textContent = left + ' 秒后播放下一集';
        return;
      }
      cancelCountdown();
      goNext(snap);
    }, 1000);

    cdState = { timer: timer, box: box, snap: snap };
  }

  function cancelCountdown() {
    if (!cdState) return;
    clearInterval(cdState.timer);
    if (cdState.box && cdState.box.parentNode) cdState.box.parentNode.removeChild(cdState.box);
    cdState = null;
  }

  function goNext(snap) {
    if (!cfg.enabled) return;

    // 有些站自己就会连播，等这几秒里它已经切了 —— 那就不再插手，免得一次跳两集
    if (snap) {
      const mv = mainVideo();
      const srcNow = (mv && (mv.currentSrc || mv.src)) || '';
      if (location.href !== snap.href || (snap.src && srcNow && srcNow !== snap.src)) {
        logAct('跳过：站点已自己切');
        toast('网站已经自己切了，跳过');
        return;
      }
    }

    const t = locateTarget();
    if (!t) {
      logAct('没找到下一个');
      toast('没找到下一个，可在设置里填自定义选择器');
      return;
    }
    if (t.end) {
      logAct('已经是最后一个');
      toast('已经是最后一个了');
      return;
    }

    if (t.playlist) {
      rememberPlayed(t.playlist.item, t.playlist.index);
      if (t.playlist.menu) savePointer(t.playlist.index);
    }
    markAutoNext();
    logAct('点击 ' + (t.playlist ? '菜单第 ' + (t.playlist.index + 1) + ' 项' : '按钮') +
           ' ' + String(t.el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 16) +
           (t.playlist && t.playlist.menu
             ? ' [跳过=' + (cfg.skipDone !== false ? '开' : '关') +
               ' 完成标记=' + (isDoneItem(t.playlist.item) ? '有' : '无') + ']'
             : ''));

    // 目标藏在折叠的子菜单里：先点开，再点它
    if (t.prepare) {
      clickEl(t.prepare);
      setTimeout(function () { clickEl(t.el); }, 600);
      return;
    }

    const href0 = location.href;
    clickEl(t.el);

    // 有些站点了 a 标签不跳转，兜一层
    setTimeout(function () {
      if (location.href === href0 && t.el && t.el.tagName === 'A' && t.el.href) {
        try { location.href = t.el.href; } catch (e) { /* ignore */ }
      }
    }, 1500);
  }

  /* ===================== 结束后自动播放 ===================== */

  const boundVideos = new WeakSet();
  const lastFire = new WeakMap();
  const loopFired = new WeakSet();

  function onEnded(video) {
    if (!cfg.enabled) return;
    if (!isMainVideo(video)) return;

    const now = Date.now();
    if (now - (lastFire.get(video) || 0) < 4000) return;
    lastFire.set(video, now);
    logAct('播完 t=' + Number(video.currentTime || 0).toFixed(1) + '/' +
           (isFinite(video.duration) ? Number(video.duration).toFixed(1) : '?'));

    startCountdown(video);
  }

  function bindVideo(v) {
    if (boundVideos.has(v)) return;
    boundVideos.add(v);

    v.addEventListener('ended', function () { onEnded(v); });

    // 有些播放器播完不 fire ended，而是停在最后一帧
    v.addEventListener('pause', function () {
      if (!isFinite(v.duration) || v.duration <= 0) return;
      if (v.ended) return;
      if (v.duration - v.currentTime > 0.8) return;
      if (v.currentTime < 1) return;
      onEnded(v);
    });

    // 有些视频开了 loop，ended 永远不触发，用接近结尾兜一下
    v.addEventListener('timeupdate', function () {
      if (!v.loop || !isFinite(v.duration) || v.duration <= 0) return;
      if (v.duration - v.currentTime > 0.25) { loopFired.delete(v); return; }
      if (loopFired.has(v)) return;
      loopFired.add(v);
      onEnded(v);
    });

    // 又点播放了，就取消倒计时
    v.addEventListener('play', function () {
      if (cdState && cdState.snap && !v.ended) cancelCountdown();
    });

    // 单页应用里换了视频但没自动播，补一手
    v.addEventListener('loadedmetadata', function () { maybeAutoPlay(v); });
    v.addEventListener('canplay', function () { maybeAutoPlay(v); });
  }

  function scan() {
    const vids = document.querySelectorAll('video');
    for (let i = 0; i < vids.length; i++) bindVideo(vids[i]);
  }

  /* 事件不一定靠得住：有的播放器播完只是停住，ended 都不 fire。
     这里每秒看一眼进度，几条路总有一条能撞上“播完了”。 */
  const watchState = new WeakMap();

  function fireEnd(v, st) {
    if (st) { st.firedAt = Date.now(); st.maxT = 0; st.lastAt = 0; }
    onEnded(v);
  }

  function checkNearEnd(v) {
    if (!cfg.enabled || cdState) return;
    if (!isMainVideo(v)) return;

    const now = Date.now();
    const t = v.currentTime || 0;
    const d = v.duration;
    if (!t && !v.ended) return;

    let st = watchState.get(v);
    if (!st) { st = { lastT: t, lastAt: now, maxT: t, firedAt: 0 }; watchState.set(v, st); }
    if (st.firedAt && now - st.firedAt < 15000) return;

    if (t < st.maxT - 5) st.maxT = t;          // 往回拖了，重新算
    if (t > st.maxT) st.maxT = t;

    const changed = Math.abs(t - st.lastT) > 0.05;
    const idle = now - st.lastAt;
    if (changed) { st.lastT = t; st.lastAt = now; }

    if (v.ended) { fireEnd(v, st); return; }
    if (!isFinite(d) || d <= 0) return;

    if (d - t <= 0.45) { fireEnd(v, st); return; }                                       // 停在结尾
    if (v.paused && !changed && idle > 1500 && d - t <= 3) { fireEnd(v, st); return; }   // 结尾处卡住
    if (v.paused && st.maxT >= d * 0.9 && t < 1) { fireEnd(v, st); return; }             // 播完把进度重置成 0
  }

  function watchdog() {
    const vids = document.querySelectorAll('video');
    for (let i = 0; i < vids.length; i++) {
      bindVideo(vids[i]);
      checkNearEnd(vids[i]);
    }
    updateVStat();
  }

  /* 播放器在 iframe 里、按钮在外层：通知顶层脚本 */
  if (window !== window.top) {
    window.addEventListener('ended', function () {
      try { window.top.postMessage({ __anv: 'ended' }, '*'); } catch (e) { /* ignore */ }
    }, true);
  }

  window.addEventListener('message', function (e) {
    if (!e.data || e.data.__anv !== 'ended') return;
    if (!cfg.enabled) return;
    const v = mainVideo();
    if (v) startCountdown(v);
  });

  /* ===================== 新页面尝试自动播放 ===================== */

  /* 单页应用里换了视频但停在暂停状态时，补一脚 */
  let lastAutoSrc = '';

  function maybeAutoPlay(v) {
    if (!cfg.forceAutoplay) return;

    let ts = 0;
    try { ts = Number(sessionStorage.getItem(AUTO_FLAG) || 0); } catch (e) { ts = 0; }
    if (!ts || Date.now() - ts > 180000) return;

    const src = v.currentSrc || v.src || '';
    if (src && src === lastAutoSrc) return;
    if (!v.paused) { lastAutoSrc = src; return; }
    if (v.readyState < 2) return;

    lastAutoSrc = src;
    v.play().catch(function () {
      v.muted = true;
      v.play().then(function () { armUnmute(v); }).catch(function () { /* ignore */ });
    });
  }

  function armUnmute(v) {
    const unmute = function () {
      v.muted = false;
      document.removeEventListener('pointerdown', unmute, true);
      document.removeEventListener('keydown', unmute, true);
    };
    document.addEventListener('pointerdown', unmute, true);
    document.addEventListener('keydown', unmute, true);
  }

  function resumePlayback() {
    if (!cfg.forceAutoplay) return;

    let ts = 0;
    try { ts = Number(sessionStorage.getItem(AUTO_FLAG) || 0); } catch (e) { ts = 0; }
    if (!ts || Date.now() - ts > 120000) return;    // 只在刚自动切过来时动手

    let tries = 0;
    const timer = setInterval(function () {
      tries += 1;
      const v = mainVideo();
      if (v && v.readyState >= 2) {
        if (!v.paused) { clearInterval(timer); return; }
        v.play().then(function () {
          clearInterval(timer);
        }).catch(function () {
          // 浏览器不让带声音自动播，先静音起播，用户一碰就恢复声音
          v.muted = true;
          v.play().then(function () {
            clearInterval(timer);
            armUnmute(v);
            toast('已自动静音播放，点一下恢复声音');
          }).catch(function () { /* 还不行就等用户手动点 */ });
        });
      }
      if (tries > 40) clearInterval(timer);
    }, 500);
  }

  /* ===================== 界面 ===================== */

  let uiRoot = null;
  let toastTimer = null;

  const CSS = [
    '.anv-fab{position:fixed;right:0;top:50%;transform:translateY(-50%);width:26px;height:58px;border-radius:8px 0 0 8px;background:rgba(18,18,22,.8);color:#fff;display:flex;align-items:center;justify-content:center;font:14px/1 system-ui,sans-serif;cursor:pointer;z-index:2147483000;opacity:.4;transition:opacity .2s;user-select:none}',
    '.anv-fab:hover{opacity:1}',
    '.anv-panel{position:fixed;right:8px;top:50%;transform:translateY(-50%);width:278px;padding:14px;border-radius:14px;background:rgba(22,22,26,.97);color:#e9e9ee;font:13px/1.6 system-ui,-apple-system,"Segoe UI","Microsoft YaHei",sans-serif;box-shadow:0 12px 40px rgba(0,0,0,.5);z-index:2147483001;display:none;max-height:80vh;overflow:auto}',
    '.anv-panel.anv-open{display:block}',
    '.anv-panel h3{margin:0 0 10px;font-size:14px;font-weight:600;display:flex;justify-content:space-between;align-items:center}',
    '.anv-panel h3 span{font-size:11px;color:#8b8b96;font-weight:400}',
    '.anv-panel label{display:flex;align-items:center;gap:8px;margin:7px 0;cursor:pointer;color:#d6d6dd}',
    '.anv-panel input[type=checkbox]{accent-color:#4c9aff;margin:0}',
    '.anv-panel input[type=number]{width:52px;background:#2a2a31;border:1px solid #3a3a44;border-radius:6px;color:#e9e9ee;padding:3px 6px}',
    '.anv-panel input[type=text]{width:100%;box-sizing:border-box;background:#2a2a31;border:1px solid #3a3a44;border-radius:6px;color:#e9e9ee;padding:5px 7px;margin-top:4px;font-size:12px}',
    '.anv-panel .anv-row{display:flex;gap:8px;margin-top:12px}',
    '.anv-panel button{flex:1;background:#33333c;border:0;border-radius:8px;color:#e9e9ee;padding:7px 0;font-size:12px;cursor:pointer;font-family:inherit}',
    '.anv-panel button:hover{background:#41414d}',
    '.anv-panel .anv-tip{margin-top:10px;font-size:11px;color:#7c7c88;line-height:1.5}',
    '.anv-info{margin-top:8px;padding:7px 9px;border-radius:8px;background:rgba(76,154,255,.12);color:#9fc4ff;font-size:11px;line-height:1.5}',
    '.anv-vstat{margin-top:6px;font-size:11px;color:#8b8b96;font-family:ui-monospace,Consolas,monospace;line-height:1.5}',
    '.anv-cd{position:fixed;left:50%;bottom:92px;transform:translateX(-50%);width:min(320px,86vw);padding:12px 14px 10px;border-radius:12px;background:rgba(20,20,24,.95);color:#fff;font:13px/1.5 system-ui,-apple-system,"Microsoft YaHei",sans-serif;box-shadow:0 10px 32px rgba(0,0,0,.45);z-index:2147483002}',
    '.anv-cd-text{margin-bottom:8px}',
    '.anv-bar{height:3px;border-radius:2px;background:#3a3a44;overflow:hidden}',
    '.anv-bar i{display:block;height:100%;width:100%;background:#4c9aff;transition:width linear}',
    '.anv-cd-row{display:flex;justify-content:flex-end;gap:8px;margin-top:8px}',
    '.anv-cd-row button{background:none;border:0;color:#9aa0b0;font:12px system-ui,sans-serif;cursor:pointer;padding:2px 4px}',
    '.anv-cd-row button:hover{color:#fff}',
    '.anv-toast{position:fixed;left:50%;bottom:40px;transform:translateX(-50%) translateY(10px);background:rgba(20,20,24,.95);color:#fff;padding:9px 16px;border-radius:20px;font:13px system-ui,-apple-system,"Microsoft YaHei",sans-serif;z-index:2147483003;opacity:0;pointer-events:none;transition:opacity .2s,transform .2s;max-width:80vw}',
    '.anv-toast.anv-show{opacity:1;transform:translateX(-50%) translateY(0)}'
  ].join('\n');

  function injectCSS() {
    try {
      if (typeof GM_addStyle === 'function') { GM_addStyle(CSS); return; }
    } catch (e) { /* ignore */ }
    const st = document.createElement('style');
    st.textContent = CSS;
    (document.head || document.documentElement).appendChild(st);
  }

  function buildUI() {
    if (uiRoot) return;
    injectCSS();

    uiRoot = document.createElement('div');
    uiRoot.setAttribute('data-anv-ui', '');
    uiRoot.innerHTML =
      '<div class="anv-fab" title="自动连播设置">⏭</div>' +
      '<div class="anv-panel">' +
        '<h3>自动连播 <span>Alt+N 可手动切</span></h3>' +
        '<label><input type="checkbox" data-k="enabled"> 播完自动下一个</label>' +
        '<label>结束后等 <input type="number" data-k="delay" min="0" max="60" step="1"> 秒</label>' +
        '<label><input type="checkbox" data-k="listMode"> 从右侧列表选下一个</label>' +
        '<label><input type="checkbox" data-k="skipDone"> 跳过已完成的</label>' +
        '<label><input type="checkbox" data-k="forceAutoplay"> 新页面自动开始播放</label>' +
        '<div class="anv-info" data-k="info"></div>' +
        '<div class="anv-vstat" data-k="vstat"></div>' +
        '<label style="display:block">自定义「下一个」按钮选择器（仅当前站点）' +
          '<input type="text" data-k="customSelector" placeholder="例如 .next-btn">' +
        '</label>' +
        '<label style="display:block">自定义列表项选择器（仅当前站点）' +
          '<input type="text" data-k="customList" placeholder="例如 .playlist li">' +
        '</label>' +
        '<div class="anv-row">' +
          '<button type="button" data-act="next">立即下一个</button>' +
          '<button type="button" data-act="diag">诊断</button>' +
          '<button type="button" data-act="reset">恢复默认</button>' +
        '</div>' +
        '<div class="anv-tip">找不到按钮时：右键那个「下一个」→ 检查 → 复制 class / id 填到上面。</div>' +
      '</div>' +
      '<div class="anv-toast"></div>';

    document.documentElement.appendChild(uiRoot);
    syncUI();
    bindUI();
  }

  function videoStatusText() {
    const v = mainVideo();
    if (!v) return 'video: 没找到';
    const d = isFinite(v.duration) ? Number(v.duration).toFixed(1) : String(v.duration);
    return 'video: ' + (v.ended ? 'ended' : (v.paused ? '暂停' : '播放')) +
           '  ' + Number(v.currentTime || 0).toFixed(1) + ' / ' + d +
           '  就绪=' + v.readyState;
  }

  function updateVStat() {
    if (!uiRoot) return;
    const el = uiRoot.querySelector('[data-k="vstat"]');
    if (el) el.textContent = videoStatusText();
  }

  function refreshInfo() {
    if (!uiRoot) return;
    const box = uiRoot.querySelector('[data-k="info"]');
    if (box) box.textContent = playlistInfo();
    updateVStat();
  }

  function syncUI() {
    if (!uiRoot) return;
    const panel = uiRoot.querySelector('.anv-panel');
    const fab = uiRoot.querySelector('.anv-fab');
    const enabled = uiRoot.querySelector('[data-k="enabled"]');
    const delay = uiRoot.querySelector('[data-k="delay"]');
    const listMode = uiRoot.querySelector('[data-k="listMode"]');
    const skipDone = uiRoot.querySelector('[data-k="skipDone"]');
    const auto = uiRoot.querySelector('[data-k="forceAutoplay"]');
    const sel = uiRoot.querySelector('[data-k="customSelector"]');
    const listSel = uiRoot.querySelector('[data-k="customList"]');

    enabled.checked = !!cfg.enabled;
    delay.value = cfg.delay;
    listMode.checked = !!cfg.listMode;
    skipDone.checked = cfg.skipDone !== false;
    auto.checked = !!cfg.forceAutoplay;
    sel.value = cfg.customSelectors[HOST] || '';
    listSel.value = cfg.customLists[HOST] || '';
    fab.style.display = cfg.showFab ? 'flex' : 'none';
    fab.title = cfg.enabled ? '自动连播：开' : '自动连播：关';
    fab.style.color = cfg.enabled ? '#fff' : '#777';
    if (panel && panel.classList) panel.dataset.on = cfg.enabled ? '1' : '0';
    refreshInfo();
  }

  function bindUI() {
    const panel = uiRoot.querySelector('.anv-panel');
    const fab = uiRoot.querySelector('.anv-fab');
    const enabled = uiRoot.querySelector('[data-k="enabled"]');
    const delay = uiRoot.querySelector('[data-k="delay"]');
    const listMode = uiRoot.querySelector('[data-k="listMode"]');
    const skipDone = uiRoot.querySelector('[data-k="skipDone"]');
    const auto = uiRoot.querySelector('[data-k="forceAutoplay"]');
    const sel = uiRoot.querySelector('[data-k="customSelector"]');
    const listSel = uiRoot.querySelector('[data-k="customList"]');

    fab.addEventListener('click', function () {
      panel.classList.toggle('anv-open');
      if (panel.classList.contains('anv-open')) refreshInfo();
    });

    enabled.addEventListener('change', function () {
      cfg.enabled = enabled.checked;
      saveCfg();
      syncUI();
      toast(cfg.enabled ? '自动连播已开启' : '自动连播已关闭');
    });

    delay.addEventListener('change', function () {
      let n = parseInt(delay.value, 10);
      if (!isFinite(n) || n < 0) n = 0;
      if (n > 60) n = 60;
      cfg.delay = n;
      delay.value = n;
      saveCfg();
    });

    listMode.addEventListener('change', function () {
      cfg.listMode = listMode.checked;
      saveCfg();
      refreshInfo();
    });

    skipDone.addEventListener('change', function () {
      cfg.skipDone = skipDone.checked;
      saveCfg();
      refreshInfo();
    });

    auto.addEventListener('change', function () {
      cfg.forceAutoplay = auto.checked;
      saveCfg();
    });

    sel.addEventListener('change', function () {
      const v = sel.value.trim();
      if (v) cfg.customSelectors[HOST] = v;
      else delete cfg.customSelectors[HOST];
      saveCfg();
      toast(v ? '按钮选择器已保存' : '已清除按钮选择器');
    });

    listSel.addEventListener('change', function () {
      const v = listSel.value.trim();
      if (v) cfg.customLists[HOST] = v;
      else delete cfg.customLists[HOST];
      saveCfg();
      toast(v ? '列表选择器已保存' : '已清除列表选择器');
      refreshInfo();
    });

    panel.addEventListener('click', function (e) {
      const act = e.target && e.target.getAttribute('data-act');
      if (act === 'next') { cancelCountdown(); goNext(null); }
      if (act === 'diag') {
        const txt = diagnose();
        copyText(txt);
        toast('诊断信息已复制，可以发给我');
      }
      if (act === 'reset') {
        Object.keys(DEFAULT_CFG).forEach(function (k) { cfg[k] = DEFAULT_CFG[k]; });
        cfg.customSelectors = {};
        cfg.customLists = {};
        saveCfg();
        syncUI();
        toast('已恢复默认');
      }
    });
  }

  function toast(msg) {
    buildUI();
    const t = uiRoot.querySelector('.anv-toast');
    if (!t) return;
    t.textContent = msg;
    t.classList.add('anv-show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.classList.remove('anv-show'); }, 2600);
  }

  /* ===================== 菜单 & 快捷键 ===================== */

  function registerMenu() {
    if (typeof GM_registerMenuCommand !== 'function') return;
    GM_registerMenuCommand('开关自动连播', function () {
      cfg.enabled = !cfg.enabled;
      saveCfg();
      syncUI();
      toast(cfg.enabled ? '自动连播已开启' : '自动连播已关闭');
    });
    GM_registerMenuCommand('打开设置面板', function () {
      buildUI();
      const p = uiRoot.querySelector('.anv-panel');
      if (p) p.classList.add('anv-open');
      refreshInfo();
    });
    GM_registerMenuCommand('立即播下一个', function () { goNext(null); });
  }

  document.addEventListener('keydown', function (e) {
    if (e.altKey && !e.ctrlKey && !e.metaKey && (e.key === 'n' || e.key === 'N')) {
      if (!cfg.enabled) return;
      e.preventDefault();
      e.stopPropagation();
      goNext(null);
    }
  }, true);

  /* ===================== 启动 ===================== */

  function boot() {
    if (cfg.showFab) buildUI();

    scan();
    new MutationObserver(function () {
      scan();
    }).observe(document.documentElement, { childList: true, subtree: true });

    setInterval(watchdog, 1000);   // 兜底：事件没来，就自己盯进度

    // 用户自己点菜单，就把指针交还给他
    document.addEventListener('click', function (e) {
      if (!e.isTrusted) return;
      const t = e.target;
      if (t && t.closest && t.closest(MENU_ITEM_SEL)) savePointer(-1);
    }, true);

    resumePlayback();
    registerMenu();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }

  window.__anv = {
    cfg: cfg,
    next: function () { goNext(null); },
    toast: toast,
    playlist: function () { return findPlaylistNext(); },
    info: playlistInfo,
    diagnose: diagnose
  };
})();
