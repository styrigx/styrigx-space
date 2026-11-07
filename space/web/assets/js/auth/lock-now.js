/**
 * @fileoverview B1-1 立即锁定（设置 › 安全与隐私 的「立即锁定」行和顶栏快捷面板的磁贴共用）。
 * 先弹确认层（#sec-locknow-confirm），确认后清掉本标签页里的管理内容缓存（ADMIN_SESSION_KEYS），
 * POST /api/lock-now 清除服务端会话 cookie，成功后 location.replace('/?lock=1') → 锁屏出现（中间不渲染主页）。
 * 请求失败（网络错误或非 2xx）：会话 cookie 可能还在，不跳锁屏、不假装已锁，toast 提示锁定失败。
 * 所有进门的人都能用，不设限。
 * 弹层关闭后 400ms 内的点击忽略（防误触，见 dialog-behavior.js）。
 */
import { sgxReplace } from '../lib/diag-jumptrace.js';
import { onDialogBackdrop, onDialogCancel, recordDialogClose, shouldIgnorePostDialogClick } from '../lib/dialog-behavior.js';
import { toast } from '../lib/toast.js';
import { i18nTable } from '../lib/i18n.js';
/** 界面文案：页面字符串表 #sgx-i18n-core（语言包化 2026-11-07；当前语言已叠在英文上） */
const tx = i18nTable('core');

/* 本标签页 sessionStorage 里的管理内容：锁定时清掉，免得同一标签页换人解锁后还能读到 */
const ADMIN_SESSION_KEYS = ['sgx-chat-convo'];

function clearAdminSessionData() {
  for (const k of ADMIN_SESSION_KEYS) {
    try { sessionStorage.removeItem(k); } catch (e) {}
  }
}

function lockFailed() {
  const en = document.documentElement.lang === 'en';
  toast(tx('lockCouldntLockThisDevice'));
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
        '<h2 class="sgx-verify-title">' + (tx('lockLockNow')) + '</h2>' +
        '<p class="sgx-verify-desc">' + (tx('lockThisDeviceWillReturn')) + '</p>' +
        '<div class="sgx-credential-foot" style="gap:12px;width:100%;max-width:400px">' +
          '<button type="button" class="sgx-credential-btn sgx-credential-btn-secondary" data-act="cancel">' + (tx('lockCancel')) + '</button>' +
          '<button type="button" class="sgx-credential-btn sgx-credential-btn-primary" data-act="ok">' + (tx('lockLock')) + '</button>' +
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
