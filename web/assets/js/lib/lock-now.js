/**
 * @fileoverview B1-1 立即锁定（设置 › 安全与隐私 的「立即锁定」行和顶栏快捷面板的磁贴共用）。
 * 先弹确认层（#sec-locknow-confirm），确认后清掉本标签页里的管理内容缓存（ADMIN_SESSION_KEYS），
 * POST /api/lock-now 清除服务端会话 cookie，成功后 location.replace('/?lock=1') → 锁屏出现（中间不渲染主页）。
 * 请求失败（网络错误或非 2xx）：会话 cookie 可能还在，不跳锁屏、不假装已锁，toast 提示锁定失败。
 * 访客和管理员都能用，不设限。
 * 弹层关闭后 400ms 内的点击忽略（防误触，见 dialog-behavior.js）。
 */
import { sgxReplace } from './diag-jumptrace.js';
import { onDialogBackdrop, onDialogCancel, recordDialogClose, shouldIgnorePostDialogClick } from './dialog-behavior.js';
import { toast } from './toast.js';

/* 本标签页 sessionStorage 里的管理内容：锁定时清掉，免得同一标签页换访客解锁后还能读到 */
const ADMIN_SESSION_KEYS = ['sgx-chat-convo'];

function clearAdminSessionData() {
  for (const k of ADMIN_SESSION_KEYS) {
    try { sessionStorage.removeItem(k); } catch (e) {}
  }
}

function lockFailed() {
  const en = document.documentElement.lang === 'en';
  toast(en ? 'Couldn’t lock this device. Check your connection and try again.' : '锁定失败，请检查网络后重试。');
}

/** 确认后执行锁定（确认层调用；单测直接调）。 */
export function doLock() {
  clearAdminSessionData();
  fetch('/api/lock-now', { method: 'POST', credentials: 'include' })
    .then(function (r) {
      if (!r.ok) {
        lockFailed();
        return;
      }
      sgxReplace('/?lock=1');
    })
    .catch(function () {
      lockFailed();
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
        '<div class="sgx-credential-foot" style="gap:12px;width:100%;max-width:400px">' +
          '<button type="button" class="sgx-credential-btn sgx-credential-btn-secondary" data-act="cancel">' + (en ? 'Cancel' : '取消') + '</button>' +
          '<button type="button" class="sgx-credential-btn sgx-credential-btn-primary" data-act="ok">' + (en ? 'Lock' : '锁定') + '</button>' +
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
