/**
 * @fileoverview B1-1 立即锁定（设置 › 安全与隐私 的「立即锁定」行和顶栏快捷面板的磁贴共用）。
 * 先弹确认层（#sec-locknow-confirm），确认后 POST /api/lock 清除服务端会话 cookie，
 * 然后 location.replace('/?lock=1') → 锁屏出现（中间不渲染主页）。访客和站长都能用，不设限。
 * 弹层关闭后 400ms 内的点击忽略（防误触，见 dialog-behavior.js）。
 */
import { sgxReplace } from './diag-jumptrace.js';
import { onDialogBackdrop, onDialogCancel, recordDialogClose, shouldIgnorePostDialogClick } from './dialog-behavior.js';

function doLock() {
  fetch('/api/lock', { method: 'POST', credentials: 'include' })
    .then(function () {
      sgxReplace('/?lock=1');
    })
    .catch(function () {
      sgxReplace('/?lock=1');
    });
}

/** 弹出「立即锁定？」确认层（确认后锁定）。 */
export function confirmLockNow() {
  if (shouldIgnorePostDialogClick()) return;
  let dlg = /** @type {HTMLDialogElement|null} */ (document.getElementById('sec-locknow-confirm'));
  if (!dlg) {
    const d = /** @type {HTMLDialogElement} */ (document.createElement('dialog'));
    dlg = d;
    d.id = 'sec-locknow-confirm';
    d.className = 'sgx-verify-dlg';
    const en = document.documentElement.lang === 'en';
    d.innerHTML =
      '<div class="sgx-verify-card">' +
        '<div class="sheet-handle"></div>' +
        '<h2 class="sgx-verify-title">' + (en ? 'Lock now?' : '立即锁定？') + '</h2>' +
        '<p class="sgx-verify-desc">' + (en ? 'This device will return to the lock screen.' : '当前设备会回到锁屏。') + '</p>' +
        '<div class="sgx-door-foot" style="gap:12px;width:100%;max-width:400px">' +
          '<button type="button" class="sgx-door-btn sgx-door-btn-secondary" data-act="cancel">' + (en ? 'Cancel' : '取消') + '</button>' +
          '<button type="button" class="sgx-door-btn sgx-door-btn-primary" data-act="ok">' + (en ? 'Lock' : '锁定') + '</button>' +
        '</div>' +
      '</div>';
    document.body.appendChild(d);
    d.addEventListener('click', function (e) {
      if (onDialogBackdrop(e, d)) { d.close(); recordDialogClose('locknow-confirm', 'backdrop'); }
    });
    d.addEventListener('cancel', function (e) {
      onDialogCancel(e, d, function () { d.close(); recordDialogClose('locknow-confirm', 'cancel'); });
    });
    const cancel = d.querySelector('[data-act="cancel"]');
    const ok = d.querySelector('[data-act="ok"]');
    if (cancel) cancel.addEventListener('click', function () {
      d.close();
      recordDialogClose('locknow-confirm', 'cancel-btn');
    });
    if (ok) ok.addEventListener('click', function () {
      d.close();
      recordDialogClose('locknow-confirm', 'confirm');
      doLock();
    });
  }
  try { dlg.showModal(); } catch (e) {}
}
