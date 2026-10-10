/**
 * @fileoverview 应用商店页：分类芯片 + 胶囊就地过滤、安装/卸载开关、锚点高亮。
 * （旧 store.html 内联脚本模块化；胶囊搜索经 setCapSearchProvider 注册。）
 */
import { on } from '../lib/events.js';
import { getJSON, setJSON } from '../lib/storage.js';
import { reducedMotion } from '../lib/util.js';
import { setCapSearchProvider } from '../shell/capsule.js';

(function () {
  /** @param {string} id */
  function $(id) {
    return document.getElementById(id);
  }

  const rows = Array.prototype.slice.call(document.querySelectorAll('#store-list .store-row'));
  if (!rows.length) return;
  let cur = 'all';

  /* ---------- sgx-apps-hidden（JSON 数组，存应用 id） ---------- */
  function hiddenList() {
    const h = getJSON('sgx-apps-hidden', []);
    return Array.isArray(h) ? h : [];
  }
  /** @param {string} id */
  function isInstalled(id) {
    return hiddenList().indexOf(id) < 0;
  }
  /** @param {string} id @param {boolean} on_ */
  function setInstalled(id, on_) {
    let h = hiddenList();
    if (on_) h = h.filter(function (x) { return x !== id; });
    else if (h.indexOf(id) < 0) h.push(id);
    setJSON('sgx-apps-hidden', h);
    window.dispatchEvent(new Event('sgx-settings-changed'));
  }

  /* ---------- 行状态绘制 ---------- */
  /** @param {Element} row */
  function paintRow(row) {
    const id = row.getAttribute('data-id') || '';
    const on_ = isInstalled(id);
    const open = row.querySelector('.store-open'),
      inst = row.querySelector('.store-install'),
      sw = row.querySelector('.switch');
    if (open) open.classList.toggle('hidden', !on_);
    if (inst) inst.classList.toggle('hidden', on_);
    if (sw) sw.setAttribute('aria-checked', on_ ? 'true' : 'false');
    return on_;
  }

  /* ---------- 分类芯片 + 搜索过滤 ---------- */
  let storeQ = '';
  function applyFilters() {
    const q = (storeQ || '').trim().toLowerCase();
    let shown = 0;
    rows.forEach(function (/** @type {Element} */ row) {
      const on_ = paintRow(row);
      const cat = row.getAttribute('data-cat');
      let ok = true;
      if (cur === 'installed') ok = on_;
      else if (cur === 'uninstalled') ok = !on_;
      else if (cur !== 'all') ok = cat === cur;
      if (ok && q) {
        const hay = (row.getAttribute('data-name') + ' ' + row.getAttribute('data-desc')).toLowerCase();
        ok = hay.indexOf(q) >= 0;
      }
      row.classList.toggle('hidden', !ok);
      if (ok) shown++;
    });
    const empty = $('store-empty');
    if (empty) empty.classList.toggle('hidden', shown > 0);
  }

  /* 胶囊输入 → 就地过滤（替代旧 window.__sgxCapSearch） */
  setCapSearchProvider(function (pg, q) {
    if (pg !== 'store') return '';
    storeQ = q || '';
    applyFilters();
    const list = $('store-list');
    if (list) {
      list.classList.remove('sgx-fade');
      void list.offsetWidth;
      list.classList.add('sgx-fade');
    }
    return '';
  });

  const chips = Array.prototype.slice.call(document.querySelectorAll('#store-chips .store-chip'));
  chips.forEach(function (/** @type {Element} */ c) {
    on(c, 'click', function () {
      cur = c.getAttribute('data-cat') || 'all';
      chips.forEach(function (/** @type {Element} */ x) {
        const on_ = x === c;
        x.classList.toggle('bg-m-primary', on_);
        x.classList.toggle('border-m-primary', on_);
        x.classList.toggle('text-m-on-primary', on_);
        x.classList.toggle('border-m-outline', !on_);
        x.classList.toggle('text-m-on-surface-variant', !on_);
      });
      applyFilters();
    });
  });

  /* ---------- 开关 + 安装按钮 ---------- */
  rows.forEach(function (/** @type {Element} */ row) {
    const id = row.getAttribute('data-id') || '';
    const sw = row.querySelector('.switch'),
      inst = row.querySelector('.store-install');
    function toggle() {
      setInstalled(id, !isInstalled(id));
      applyFilters();
    }
    if (sw) {
      sw.setAttribute('tabindex', '0');
      on(sw, 'click', function (e) {
        e.stopPropagation();
        toggle();
      });
      on(sw, 'keydown', function (/** @type {KeyboardEvent} */ e) {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          toggle();
        }
      });
    }
    if (inst)
      on(inst, 'click', function () {
        setInstalled(id, true);
        applyFilters();
      });
  });

  /* ---------- 锚点定位 #app-xxx：高亮 1 秒 ---------- */
  function anchorJump() {
    const h = (location.hash || '').replace(/^#/, '');
    if (h.indexOf('app-') !== 0) return;
    const el = document.getElementById(h);
    if (!el) return;
    el.scrollIntoView({ block: 'center', behavior: reducedMotion() ? 'auto' : 'smooth' });
    el.classList.add('set-hl');
    window.setTimeout(function () {
      el.classList.remove('set-hl');
    }, 1100);
  }
  on(window, 'hashchange', anchorJump);

  /* ---------- 初始化 ---------- */
  rows.forEach(paintRow);
  applyFilters();
  anchorJump();
})();
