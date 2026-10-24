/**
 * @fileoverview 账号 → 云同步（/account/sync/，2026-10-24 PR4）：总开关 + 实际同步的每一项（名字 + 本机当前值）。
 *
 * - 总开关：localStorage sgx-cloud-sync（'0' = 关，默认开），与原来总览那一行的开关同一个 key；打开时立刻同步一次（initCloudSync force）。
 *   副标题与总览「云同步」一行同一句（account-common.js syncSubText）。
 * - 同步项：模板按 data/sync-items.yaml 渲染（与 lib/cloud-sync.js syncKeys() 一一对应，单测核对）；这里只填当前值（lib/sync-items.js valueText）。
 *   本页同步拉下新值时 cloud-sync.js 会刷新页面一次，值跟着更新；别的标签页改了设置（storage 事件）就地重填。
 * - 进页查一次账号会话：明确没有 → 回账号页登录，登录后回本页；有 → 清掉「没登录账号」标记、开着就同步一次（同总览）。
 */
import { on } from '../lib/events.js';
import { initCloudSync, syncEnabled, SWITCH_KEY, AUTH_KEY } from '../lib/cloud-sync.js';
import { get as sget, set as sset } from '../lib/storage.js';
import { valueText, defOf } from '../lib/sync-items.js';
import { createT, requireAccountSession, syncSubText } from './account-common.js';

(function () {
  const root = document.getElementById('acct-sync');
  if (!root) return;
  const en = document.documentElement.lang === 'en';
  const t = createT(en);
  const row = document.getElementById('acct-sync-row');
  const sw = document.getElementById('acct-sync-sw');
  const sub = document.getElementById('acct-sync-sub');
  const items = document.getElementById('acct-sync-items');

  function paintSwitch() {
    const onNow = syncEnabled();
    if (sw) sw.setAttribute('aria-checked', onNow ? 'true' : 'false');
    if (sub) sub.textContent = syncSubText(t, en);
    if (items) items.classList.toggle('is-off', !onNow);
  }

  function paintValues() {
    document.querySelectorAll('#acct-sync-items [data-sync-key]').forEach(function (el) {
      const key = el.getAttribute('data-sync-key') || '';
      const raw = sget(key, null);
      const d = defOf(el);
      const val = el.querySelector('[data-sync-val]');
      if (val) val.textContent = valueText(d, raw, t);
      const swatch = /** @type {HTMLElement|null} */ (el.querySelector('[data-sync-swatch]'));
      if (swatch) {
        const ok = !!raw && /^#[0-9a-fA-F]{6}$/.test(raw);
        swatch.hidden = !ok;
        if (ok) swatch.style.backgroundColor = raw;
      }
    });
  }

  function refreshAfterSync() {
    paintSwitch();
    paintValues();
  }

  if (row) {
    const toggle = function () {
      const turnOn = !syncEnabled();
      sset(SWITCH_KEY, turnOn ? null : '0');
      paintSwitch();
      if (turnOn) initCloudSync({ force: true }).then(refreshAfterSync, refreshAfterSync);
    };
    on(row, 'click', toggle);
    on(row, 'keydown', function (e) {
      const ev = /** @type {KeyboardEvent} */ (e);
      if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); toggle(); }
    });
  }

  /* 别的标签页改了设置 / 开关：就地重填 */
  window.addEventListener('storage', function () { refreshAfterSync(); });

  paintSwitch();
  paintValues();

  requireAccountSession(en).then(function (j) {
    if (!j) return;
    sset(AUTH_KEY, 'in');
    if (syncEnabled()) initCloudSync({ force: true }).then(refreshAfterSync, refreshAfterSync);
  });
})();
