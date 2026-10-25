/**
 * @fileoverview 安全与隐私 → 锁屏凭证（/settings/security/lock/）。
 * - 门（安全操作）：进页 POST /api/lock-reauth status —— 没有有效reauth 票 → 显示验证行：
 *   锁屏通行密钥 / 解锁密码（设了哪个显示哪个）+ 根凭证（一直在，防止忘了凭证网站就死了）；
 *   通过后签 3 分钟LockReauthTicket（SGX_LOCK_* 签，HttpOnly cookie），页内倒计时按服务端 expiresAt；
 *   剩余时间内刷新 / 离开再回来都不用重新验证（2026-10-24，以前 pagehide 就作废），到期回门口。
 * - 门内：解锁密码（弹层设置/修改，最少 8 位）；锁屏通行密钥列表（设备名可编辑、注册日期、可删除），
 *   「添加通行密钥」；会话：退出所有设备（/api/lock-all-devices，所有设备回锁屏）。
 * - 重置锁屏（data-sgx-lock-session=lock-reset，LockResetTicket）：直接进门内，只能设置密码 / 增删通行密钥。
 * - 反馈一律 One UI 轻提示（toast）；localStorage 经 storage.js。
 */
import { on } from '../lib/events.js';
import { toast } from '../lib/toast.js';
import { followKeyboard } from '../shell/vk.js';
import { releaseLockScreen } from '../shell/lock-guard.js';
import { sgxReplace } from '../lib/diag-jumptrace.js';
import { onDialogBackdrop, onDialogCancel, recordDialogClose, bindSubmitButton, showCenterDialog } from '../lib/dialog-behavior.js';
import { api, apiErrorText, needVerify, startReauthCountdown, refreshReauthCountdown, guardReauthExpired } from './app-gate.js';
import { registerPasskey, createPkNameDialog, genPkPrefillName } from '../auth/passkey-register.js';
import { getPasskeyAssertion, assertionOptions, assertionToJSON, isPasskeyCancel } from '../auth/passkey-assert.js';
import { bindDataEyes, createSetPwDialog, newPwError, passwordSetRequest, lockReauthFetch } from '../auth/auth-flow.js';
import { renderAccountMethods } from '../auth/account-methods.js';
import { KEY_LOCK } from '../lib/key-names.js';

(function () {
  const en = document.documentElement.lang === 'en';
  /* 本页只管锁屏凭证（锁屏密码 + 锁屏通行密钥；接口按路径分域，/api/lock-*）。 */
  /** C6：重置会话模式（LockResetTicket）。重置会话里不使用门内到期框。 */
  var isLockReset = false;
  try {
    isLockReset = document.documentElement.dataset.sgxLockSession === 'lock-reset';
  } catch (e) {}
  /** 状态接口：锁屏层 */
  const statusApi = '/api/lock-credentials';
  /** @type {any} */
  let T = {};
  try {
    T = JSON.parse(document.getElementById('sgx-i18n-lockmgr').textContent || '{}');
  } catch (e) {}
  /** @param {string} k */
  function t(k) {
    const v = T[k];
    if (v && typeof v === 'object') return en ? v.en : v.zh;
    if (v) return v;
    /* 批次 A 收尾 #36：兜底不显示内部键名；键名只记诊断 */
    if (typeof console !== 'undefined') console.warn('[i18n] missing key:', k);
    return en ? 'Something went wrong, please retry' : '出错了，请重试';
  }
  /** @param {string} id */
  function $(id) {
    return document.getElementById(id);
  }

  let hasPw = false;

  /* ---------- 通用 ---------- */
  /** @param {string} id @param {string} msg */
  function showErr(id, msg) {
    const e = $(id);
    if (e) {
      e.textContent = msg;
      e.hidden = false;
    }
  }
  /** @param {string} id */
  function hideErr(id) {
    const e = $(id);
    if (e) e.hidden = true;
  }
  /* 门内直调接口（POST JSON，credentials: include，返回 { status, json }）：用 app-gate.js 的 api()，
     定稿 #19：不自动发起验证，reauth（reauth 票没了/过期）直接返回给调用方。 */

  /** @param {number} ts */
  function fmtDate(ts) {
    try {
      const d = new Date(ts);
      const p = function (n) {
        return String(n).padStart(2, '0');
      };
      return en
        ? d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate())
        : d.getFullYear() + '年' + (d.getMonth() + 1) + '月' + d.getDate() + '日';
    } catch (e) {
      return '';
    }
  }
  /* session/reauth/scope → needReauth，不显示通用错误（走重新验证流程，不向用户展示开发用语）。 */
  function isReauthError(code) {
    return code === 'session' || code === 'reauth' || code === 'scope';
  }
  /* 批次 A 收尾 E1：config 错误码映射成「服务器配置有误」，不再显示 gateSrvErr 原文。
     srvErr 改为 apiErrorText（config → errConfig →「服务器配置有误」）。 */
  function srvErr(code, status) {
    return apiErrorText(t, code, status);
  }

  /** 会话/票据失效 → 重新验证（批次 A 验收修复 #7：改走 app-gate.js 的 needVerify，
      和 tickets.js 一致；detail='account-configured' 时 needVerify 显示明确文案）。
      A-1：按真实 code 传参（v1.0 §三 1c）——'session' 走会话弹框，
      'reauth'/'scope' 走验证弹框；单参调用（仅 reason，如 'account-configured'）
      视为验证弹框。锁屏页无验证门可开：lockgate-* 元素在任何模板里都不存在，
      旧 openGate() 在 gateOpts 为 null 时会抛 TypeError。 */
  function needReauth(code, detail) {
    /* P2-14：先收起当前所有 sheet 再弹框，禁止弹层叠弹层 */
    closeOpenSheets();
    /* C6：重置会话里不使用门内到期框 */
    if (isLockReset) {
      showLockResetDoneDialog();
      return;
    }
    if (code === 'session') needVerify(t, 'session', detail);
    else needVerify(t, 'reauth', detail || code);
  }

  /**
   * C6：重置会话的结束弹框（不用门内到期框）。
   * - 已设置好凭证（hasPw || hasPk）：「解锁方式已设置，请回锁屏解锁」
   * - 真到期（未设置好）：「验证已过期，请回锁屏重新开始」
   * 按钮都是「去锁屏」，一律 location.replace('/?lock=1')，不经主页。
   */
  function showLockResetDoneDialog() {
    var done = hasPw || hasPk;
    showCenterDialog({
      title: done
        ? (en ? 'Setup complete' : '设置完成')
        : (en ? 'Verification expired' : '验证已过期'),
      desc: done
        ? (en ? 'Unlock method is set. Please go back to the lock screen to unlock.'
              : '解锁方式已设置，请回锁屏解锁')
        : (en ? 'Please go back to the lock screen to start over.'
              : '验证已过期，请回锁屏重新开始'),
      dismissible: false,
      buttons: [{
        label: en ? 'Go to lock screen' : '去锁屏',
        kind: 'primary',
        onClick: function () {
          try { sgxReplace('/?lock=1'); } catch (e) {}
        },
      }],
    });
  }

  /**
   * P2-14：收起当前所有打开的 sheet（验证身份/密码/命名弹层）。
   * 切换弹层前调用，保证同一时刻只有一个弹层。
   */
  function closeOpenSheets() {
    ['lockpw-dlg', 'lockpkname-dlg', 'lockpkdel-dlg'].forEach(function (id) {
      const d = $(id);
      try {
        if (d && d.open) d.close();
      } catch (e) {}
    });
  }

  /** @param {number} [expiresAt] 服务端reauth 票过期时刻（毫秒） */
  function enterMgr(expiresAt) {
    /* 本页有独立验证门；进管理区时去掉全局锁屏（含还在按需加载的），避免盖住按钮 */
    releaseLockScreen();
    $('lockmgr').hidden = false;
    const sessSec = $('lockmgr-sessions');
    if (sessSec) sessSec.hidden = isLockReset;
    /* v1.1 §二.1：胶囊在首次数据加载完成后再显示，避免「胶囊已显示、卡片还空着」；
       任一请求失败也照常显示胶囊（两函数内部已吞错，Promise 恒 resolve）。 */
    const startCapsule = function () { startReauthCountdown(t, expiresAt); };
    Promise.all([refreshStatus(), refreshPkList()]).then(startCapsule, startCapsule);
  }

  /* 显示/隐藏眼睛（批次 A 验收修复 P2：bindEyeButton 统一接管图标 + 文案 + 复位） */
  const eyeResets = bindDataEyes(t);

  /* ---------- 管理区 ---------- */
  var hasPk = false;
  /* v1.1 §二.1：返回请求 Promise，供进门回调等首次数据加载完成后再显示胶囊 */
  function refreshStatus() {
    /* 状态接口：/api/lock-credentials（lock-password + lock-passkey:*） */
    return fetch(statusApi, { method: 'GET', credentials: 'same-origin' })
      .then(function (r) {
        return r.json();
      })
      .then(function (j) {
        /* 失败（401/503）时保持当前显示，不误报「未设置」 */
        if (!(j && j.ok)) return;
        hasPw = !!j.password;
        hasPk = !!j.passkey;
        const sub = $('lockmgr-pwsub');
        if (sub) sub.textContent = hasPw ? t('pwSet') : t('pwUnset');
        const title = $('lockpw-title');
        if (title) title.textContent = hasPw ? t('changeTitle') : t('setTitle');
        const delBtn = $('lockmgr-pwdel');
        if (delBtn) delBtn.hidden = !hasPw;
      })
      .catch(function () {});
  }

  /* 密码弹层 */
  /* 设置/修改密码弹层（打开/关闭/遮罩/× 按钮/密码行，见 auth/auth-flow.js） */
  const pwDialog = createSetPwDialog({
    $: $,
    t: t,
    hideErr: hideErr,
    followKeyboard: followKeyboard,
    eyeResets: eyeResets,
    hasPw: function () { return hasPw; },
  });
  const closePwDlg = pwDialog.close;
  /* 删除解锁密码（两步确认） */
  const pwDel = $('lockmgr-pwdel');
  if (pwDel) {
    let armed = false;
    let armTimer = 0;
    const origText = pwDel.textContent;
    on(pwDel, 'click', function () {
      /* C5：已过期时第一下就弹到期框，不进入「再点一次」 */
      if (guardReauthExpired(t)) return;
      /* v1.1 §二.4：删最后一把锁屏密码 → 跳过「再点一次」，点「删除」直接弹确认框 */
      if (!hasPk) {
        var resetArmed = function () { armed = false; pwDel.textContent = origText; pwDel.classList.remove('armed'); };
        showCenterDialog({
          title: t('lastKeyConfirmTitle'),
          desc: t('lastKeyConfirmDesc'),
          dismissible: true,
          onCancel: resetArmed,
          buttons: [
            { label: t('lastKeyConfirmCancel'), kind: 'ghost', onClick: resetArmed },
            { label: t('lastKeyConfirmDelete'), kind: 'primary', onClick: function () { doRemovePw(); } },
          ],
        });
        return;
      }
      if (!armed) {
        armed = true;
        /* 如果删完后密码和通行密钥都没了：锁屏只能通过重置锁屏重新设置。 */
        if (!hasPk) {
          pwDel.textContent = t('pwDelWarnLock');
        } else {
          pwDel.textContent = t('pwDelAsk');
        }
        pwDel.classList.add('armed');
        armTimer = window.setTimeout(function () {
          armed = false;
          pwDel.textContent = origText;
          pwDel.classList.remove('armed');
        }, 5000);
        return;
      }
      window.clearTimeout(armTimer);
      doRemovePw();
      function doRemovePw() {
      api('/api/lock-password', { action: 'remove' })
        .then(function (r) {
          const j = r.json;
          if (j && j.ok) {
            toast(t('pwDeleted'));
            /* 服务端删除成功后重新读状态刷新（KV 最终一致，边缘节点最多约 60 秒） */
            refreshStatus();
            refreshPkList();
            refreshReauthCountdown(t);
          } else if (j && isReauthError(j.error)) {
            needReauth(j && j.error, j && j.reason);
          } else {
            toast(srvErr(j && j.error, r.status));
          }
        })
        .catch(function () {
          toast(t('gateNetErr'));
        })
        .finally(function () {
          armed = false;
          pwDel.textContent = origText;
          pwDel.classList.remove('armed');
        });
      }
    });
  }
  function submitPw() {
    const a = $('lockpw-1'), b = $('lockpw-2');
    const va = a ? a.value : '', vb = b ? b.value : '';
    hideErr('lockpw-err');
    const pwErr = newPwError(va, vb);
    if (pwErr) {
      showErr('lockpw-err', t(pwErr));
      return;
    }
    const req = passwordSetRequest(hasPw, va);
    const action = req.action;
    const body = req.body;
    api('/api/lock-password', body)
      .then(function (res) {
        const j = res.json;
        if (!j) {
          showErr('lockpw-err', srvErr(null, res.status));
          return;
        }
        if (j.ok) {
          closePwDlg('success');
          hasPw = true;
          refreshStatus();
          refreshReauthCountdown(t);
          toast(hasPw && action === 'change' ? t('pwChanged') : t('pwSaved'));
        } else if (isReauthError(j.error)) {
          closePwDlg('success');
          needReauth(j && j.error, j && j.reason);
        } else if (j.error === 'exists' && action === 'set') {
          /* 并发已设置 → 改走 change */
          hasPw = true;
          refreshStatus();
          showErr('lockpw-err', t('pwMin8'));
        } else {
          showErr('lockpw-err', srvErr(j.error, res.status));
        }
      })
      .catch(function () {
        showErr('lockpw-err', t('gateNetErr'));
      });
  }
  const pwGo = $('lockpw-go');
  /* 批次 A 收尾：pointerup（要求 pointerdown 也在按钮）+ click 兜底，去重只提交一次 */
  if (pwGo) bindSubmitButton(pwGo, submitPw);

  /* 通行密钥命名弹层（auth/passkey-register.js，账号安全页同一份） */
  const pkName = createPkNameDialog({
    rename: function (credId, name) {
      return api('/api/lock-passkey', { action: 'rename', credId: credId, name: name }).then(function (r) {
        const j = r.json;
        if (j && j.ok) {
          refreshReauthCountdown(t);
          return 'ok';
        }
        if (j && isReauthError(j.error)) {
          /* C6：重置会话里 rename 被拒（scope）不是过期，行内提示，不弹框 */
          if (isLockReset && j.error === 'scope') return t('pkRenameResetNo');
          needReauth(j && j.error, j && j.reason);
          return null;
        }
        /* KV 最终一致：刚注册的 key 可能暂时读不到 */
        if (j && j.error === 'not-found') return t('pkRetryLater');
        if (!j) return t('gateNetErr');
        return srvErr(j.error, r.status);
      });
    },
    onDone: function () { refreshPkList(); },
    toast: toast,
    registeredText: t('pkRegistered'),
    emptyText: t('pkNameEmpty'),
    networkText: t('gateNetErr'),
  });
  /* P2-13：命名输入框聚焦时，命名弹层随键盘上移 */
  followKeyboard($('lockpkname-dlg'), $('lockpkname-input'));

  /* 应用钥匙删除确认弹层（站内确认，替代原生 confirm；返回 Promise<boolean>） */
  let pkDelResolve = null;
  function openPkDelDlg() {
    return new Promise(function (resolve) {
      pkDelResolve = resolve;
      const desc = $('lockpkdel-desc');
      if (desc) desc.textContent = t('pkDelConfirm');
      const dlg = $('lockpkdel-dlg');
      if (!dlg) { resolve(false); return; }
      try { dlg.showModal(); } catch (e) {}
    });
  }
  function closePkDelDlg(ok, reason) {
    recordDialogClose('lockpkdel', reason || 'unknown');
    const dlg = $('lockpkdel-dlg');
    try { if (dlg && dlg.open) dlg.close(); } catch (e) {}
    if (pkDelResolve) { pkDelResolve(!!ok); pkDelResolve = null; }
  }
  const pkDelCancel = $('lockpkdel-cancel');
  if (pkDelCancel) on(pkDelCancel, 'click', function () { closePkDelDlg(false, 'cancel-btn'); });
  const pkDelOk = $('lockpkdel-ok');
  if (pkDelOk) on(pkDelOk, 'click', function () { closePkDelDlg(true, 'success'); });
  const pkDelDlg = $('lockpkdel-dlg');
  if (pkDelDlg) {
    /* 批次 A 收尾 A1/A2/A3：删除确认遮罩不关、返回先收键盘、× 关闭 */
    on(pkDelDlg, 'click', function (/** @type {MouseEvent} */ e) {
      onDialogBackdrop(e, pkDelDlg);
    });
    on(pkDelDlg, 'cancel', function (/** @type {Event} */ e) {
      onDialogCancel(e, pkDelDlg, function (reason) { closePkDelDlg(false, reason); });
    });
    const pkDelClose = pkDelDlg.querySelector('[data-dlg-close]');
    if (pkDelClose) on(pkDelClose, 'click', function () { closePkDelDlg(false, 'close-btn'); });
  }

  /* 通行密钥列表（批次 A 验收修复 P0：list 带页面类别，只显示本页类） */
  function refreshPkList() {
    const ul = $('lockmgr-pklist');
    const empty = $('lockmgr-pkempty');
    return api('/api/lock-passkey', { action: 'list' })
      .then(function (res) {
        const j = res.json;
        if (!j) return;
        if (j.error && isReauthError(j.error)) {
          needReauth(j && j.error, j && j.reason);
          return;
        }
        if (!j.ok) {
          /* 读失败：不要显示成「还没有通行密钥」（2026-10-24） */
          pkListState(t('pkListFail'));
          return;
        }
        const keys = j.keys || [];
        if (!ul) return;
        ul.innerHTML = '';
        keys.forEach(function (k) {
          const li = document.createElement('li');
          li.className = 'lockmgr-pkitem';
          const nameWrap = document.createElement('div');
          nameWrap.className = 'lockmgr-pkname';
          const nameInput = document.createElement('input');
          nameInput.type = 'text';
          nameInput.value = k.name || '';
          nameInput.placeholder = t('pkUnnamed');
          nameInput.maxLength = 40;
          nameInput.setAttribute('aria-label', t('pkUnnamed'));
          let lastSaved = k.name || '';
          const saveName = function () {
            const v = nameInput.value.trim();
            if (v === lastSaved) return;
            api('/api/lock-passkey', { action: 'rename', credId: k.credId, name: v })
              .then(function (r2) {
                const jj = r2.json;
                if (jj && jj.ok) {
                  lastSaved = v;
                  toast(t('pkRenamed'));
                } else if (jj && isReauthError(jj.error)) {
                  needReauth(jj.error, jj.reason);
                } else {
                  nameInput.value = lastSaved;
                }
              })
              .catch(function () {
                nameInput.value = lastSaved;
              });
          };
          on(nameInput, 'change', saveName);
          on(nameInput, 'keydown', function (/** @type {KeyboardEvent} */ e) {
            if (e.key === 'Enter') {
              e.preventDefault();
              nameInput.blur();
            }
            e.stopPropagation();
          });
          on(nameInput, 'click', function (e) {
            e.stopPropagation();
          });
          const meta = document.createElement('span');
          meta.className = 'lockmgr-pkdate';
          /* 副标题：provider + 创建于 + 最近使用（lastUsedAt 为 0 显示“尚未使用”） */
          let metaText = '创建于 ' + fmtDate(k.createdAt);
          if (k.lastUsedAt) {
            metaText += ' · 最近使用 ' + fmtDate(k.lastUsedAt);
          } else {
            metaText += ' · ' + t('pkNeverUsed');
          }
          /* provider 显示（如果有） */
          if (k.provider) {
            metaText = k.provider + ' · ' + metaText;
          }
          meta.textContent = metaText;
          nameWrap.appendChild(nameInput);
          nameWrap.appendChild(meta);
          const del = document.createElement('button');
          del.type = 'button';
          del.className = 'lockmgr-pkdel';
          del.textContent = t('pkDel');
          let armed = false;
          let armTimer = 0;
          on(del, 'click', function (e) {
            e.stopPropagation();
            /* C5：已过期时第一下就弹到期框，不进入「再点一次」 */
            if (guardReauthExpired(t)) return;
            /* v1.1 §二.4：删最后一把锁屏钥匙 → 跳过「再点一次」，点「删除」直接弹确认框 */
            if (keys.length <= 1 && !hasPw) {
              var resetPkArmed = function () { armed = false; del.textContent = t('pkDel'); del.classList.remove('armed'); };
              showCenterDialog({
                title: t('lastKeyConfirmTitle'),
                desc: t('lastKeyConfirmDesc'),
                dismissible: true,
                onCancel: resetPkArmed,
                buttons: [
                  { label: t('lastKeyConfirmCancel'), kind: 'ghost', onClick: resetPkArmed },
                  { label: t('lastKeyConfirmDelete'), kind: 'primary', onClick: function () { doDeleteKey(); } },
                ],
              });
              return;
            }
            if (!armed) {
              armed = true;
              del.textContent = t('pkDelAsk');
              del.classList.add('armed');
              armTimer = window.setTimeout(function () {
                armed = false;
                del.textContent = t('pkDel');
                del.classList.remove('armed');
              }, 3000);
              return;
            }
            window.clearTimeout(armTimer);
            doDeleteKey();
            function doDeleteKey() {
            api('/api/lock-passkey', { action: 'delete', credId: k.credId })
              .then(function (r2) {
                const jj = r2.json;
                if (jj && jj.ok) {
                  toast(t('pkDeleted'));
                  /* Samsung Pass 同步：通知密码管理器删掉这把密钥 */
                  try {
                    if (window.PublicKeyCredential && typeof PublicKeyCredential.signalUnknownCredential === 'function') {
                      PublicKeyCredential.signalUnknownCredential({ rpId: location.hostname, credentialId: k.credId }).catch(function () {});
                    } else {
                      toast(t('pkDelManual'));
                    }
                  } catch (e) {}
                  /* 服务端删除成功后重新读列表刷新（KV 最终一致，边缘节点最多约 60 秒） */
                  refreshPkList();
                  refreshStatus();
                  refreshReauthCountdown(t);
                } else if (jj && isReauthError(jj.error)) {
                  needReauth(jj.error, jj.reason);
                } else if (jj && jj.error === 'not-found') {
                  toast(t('pkRetryLater'));
                } else if (!jj) {
                  toast(t('gateNetErr'));
                } else {
                  toast(srvErr(jj.error, r2.status));
                }
              })
              .catch(function () {
                toast(t('gateNetErr'));
              });
            }
          });
          li.appendChild(nameWrap);
          li.appendChild(del);
          ul.appendChild(li);
        });
        ul.hidden = keys.length === 0;
        ul.removeAttribute('aria-busy');
        if (empty) empty.hidden = keys.length !== 0;
        if (pkAddBtn) pkAddBtn.hidden = false;
      })
      .catch(function () { pkListState(t('pkListFail')); });
  }
  /** 列表占位行（加载失败）：替换「正在加载」，「添加通行密钥」照常可用 @param {string} msg */
  function pkListState(msg) {
    const ul = $('lockmgr-pklist');
    if (ul && ul.querySelector('#lockmgr-pkloading')) {
      ul.innerHTML = '<li class="lockmgr-pkloading" id="lockmgr-pkloading" role="status"></li>';
      const li = ul.querySelector('li');
      if (li) li.textContent = msg;
      ul.hidden = false;
      ul.removeAttribute('aria-busy');
    }
    if (pkAddBtn) pkAddBtn.hidden = false;
  }
  const pkAddBtn = $('lockmgr-pkadd');

  /* 添加通行密钥 */
  const pkAdd = $('lockmgr-pkadd');
  if (pkAdd) {
    on(pkAdd, 'click', function () {
      /* 本页只注册锁屏通行密钥；服务端按reauth 票再校验。流程在 auth/passkey-register.js（账号安全页同一份） */
      registerPasskey({
        challenge: function () { return api('/api/lock-passkey', { action: 'challenge', type: 'register' }); },
        register: function (body) { return api('/api/lock-passkey', Object.assign({ action: 'register' }, body)); },
        onAuthError: function (res) {
          const j = res.json;
          if (j && !j.ok && isReauthError(j.error)) {
            needReauth(j.error, j.reason);
            return true;
          }
          return false;
        },
        onRegistered: function (credId, prefill) {
          /* 注册成功 → 弹出命名弹层（预填名已提交，用户改名才调 rename） */
          pkName.open(credId, prefill);
          refreshPkList();
          refreshReauthCountdown(t);
        },
        prefill: function () { return genPkPrefillName(t('pkUnnamed')); },
        errText: srvErr,
        toast: toast,
        msg: { cancelled: t('gateCancelled'), already: t('pkAlready'), noSupport: t('pkNoSupport'), failed: t('pkFailed'), network: t('gateNetErr') },
        userFallback: { name: KEY_LOCK, displayName: 'Sloan Gray' },
      });
    });
  }

  /* ================= 会话：退出所有设备 ================= */
  const outAll = $('lockmgr-outall');
  if (outAll) {
    on(outAll, 'keydown', function (/** @type {KeyboardEvent} */ e) {
      if (e.key === 'Enter') {
        e.preventDefault();
        outAll.click();
      }
    });
    on(outAll, 'click', function () {
      if (guardReauthExpired(t)) return;
      closeOpenSheets();
      showCenterDialog({
        title: t('outAllTitle'),
        desc: t('outAllDesc'),
        dismissible: true,
        buttons: [
          { label: t('lastKeyConfirmCancel'), kind: 'ghost', onClick: function () {} },
          {
            label: t('outAllBtn'),
            kind: 'primary',
            onClick: function () {
              api('/api/lock-all-devices', {})
                .then(function (res) {
                  const j = res.json;
                  if (j && j.ok) {
                    /* 当前设备也一起锁上：回锁屏 */
                    sgxReplace('/?lock=1');
                  } else if (j && isReauthError(j.error)) {
                    needReauth(j.error, j.reason);
                  } else {
                    toast(srvErr(j && j.error, res.status));
                  }
                })
                .catch(function () { toast(t('gateNetErr')); });
            },
          },
        ],
      });
    });
  }

  /* ================= 门：验证行 ================= */
  const reauthEl = $('lock-reauth');
  const reauthMethodsEl = $('lock-reauth-methods');
  const reauthNotice = $('lock-reauth-notice');
  let reauthMethods = null;

  /** 门口三个入口的提交函数（成功 resolve；失败 reject { message, clear?, cancelled? }） */
  const reauthSubmit = {
    /** @param {string} value */
    password: function (value) {
      return api('/api/lock-password', { action: 'verify', password: value, reauth: true }).then(function (res) {
        const j = res.json;
        if (j && j.ok) return;
        if (res.status === 429 || (j && j.error === 'cooldown')) throw { message: t('errLocked') };
        if (j && j.error === 'wrong') throw { message: t('errWrongPw'), clear: true };
        throw { message: srvErr(j && j.error, res.status) };
      }, function () {
        throw { message: t('errNetwork') };
      });
    },
    /** @param {string} value */
    root: function (value) {
      return api('/api/root-auth', { key: value, purpose: 'lock-reauth' }).then(function (res) {
        const j = res.json;
        if (j && j.ok) return;
        if (res.status === 429) throw { message: t('errLocked') };
        if (j && j.error === 'config') throw { message: t('errConfig') };
        throw { message: t('errWrongRoot'), clear: true };
      }, function () {
        throw { message: t('errNetwork') };
      });
    },
    passkey: function () {
      if (!window.PublicKeyCredential) return Promise.reject({ message: t('pkNoSupport') });
      return api('/api/lock-passkey', { action: 'challenge', type: 'auth' }).then(function (res) {
        const j = res.json;
        if (!j || !j.ok || !j.challenge) throw { message: srvErr(j && j.error, res.status) };
        return getPasskeyAssertion(assertionOptions(j)).then(function (cred) {
          return { cred: /** @type {any} */ (cred), cid: j.cid };
        }, function (e) {
          if (isPasskeyCancel(e)) throw { cancelled: true };
          throw { message: t('errVerify') };
        });
      }, function () {
        throw { message: t('errNetwork') };
      }).then(function (r) {
        const cred = r.cred;
        return api('/api/lock-passkey', {
          action: 'auth',
          reauth: true,
          cid: r.cid,
          credential: assertionToJSON(cred),
        }).then(function (res) {
          const j = res.json;
          if (j && j.ok) return;
          throw { message: srvErr(j && j.error, res.status) };
        }, function () {
          throw { message: t('errNetwork') };
        });
      });
    },
  };

  /**
   * 显示门口（验证行）：设了哪个锁屏凭证显示哪个，根凭证一直在。
   * @param {{password?:boolean, passkey?:boolean}} st
   * @param {string} [notice]
   */
  function showReauth(st, notice) {
    releaseLockScreen();
    $('lockmgr').hidden = true;
    if (!reauthEl || !reauthMethodsEl) return;
    if (reauthMethods) reauthMethods.collapse();
    const kinds = [];
    if (st && st.passkey) kinds.push('passkey');
    if (st && st.password) kinds.push('password');
    kinds.push('root');
    reauthMethods = renderAccountMethods({
      el: reauthMethodsEl,
      t: t,
      en: en,
      kinds: kinds,
      submit: reauthSubmit,
      pmUser: KEY_LOCK,
      onSuccess: function () { probe(); },
    });
    if (reauthNotice) {
      reauthNotice.textContent = notice || '';
      reauthNotice.hidden = !notice;
    }
    reauthEl.hidden = false;
  }

  /** 进页 / 验证通过后：读reauth 票状态 → 门内或门口 */
  function probe() {
    lockReauthFetch('status', { credentials: 'same-origin' })
      .then(function (r) {
        return r.json().then(function (j) { return { s: r.status, j: j }; }, function () { return { s: r.status, j: null }; });
      })
      .then(function (res) {
        const j = res.j;
        if (j && j.ok && j.valid) {
          if (reauthEl) reauthEl.hidden = true;
          enterMgr(j.expiresAt);
          return;
        }
        if (isLockReset) {
          /* 重置会话：reauth 票没了（到期 / 已用完）→ 结束弹框，回锁屏 */
          needReauth('reauth');
          return;
        }
        if (j && j.ok) {
          showReauth(j);
          return;
        }
        needReauth((j && j.error) || 'session', j && j.reason);
      })
      .catch(function () {
        /* 网络失败 ≠ 过期：提示网络错误，留页不弹框、不自动跳 */
        toast(t('gateNetErr'));
      });
  }

  /* 2026-10-24（用户录屏：验证完一刷新就「验证已过期」）：以前 pagehide 就 clear reauth 票，刷新也会触发 pagehide，
     等于每次刷新都把刚签的票作废。现在reauth 票只看服务端：sgx-lock-reauth / sgx-lock-reset（HttpOnly、Secure、SameSite=Strict、Max-Age=180，
     签名里带 exp = 验证时刻 + 3 分钟）在剩余时间内刷新 / 离开再回来都还有效，倒计时按服务端 status 的 expiresAt 接着走；
     到期由服务端判定，回到门口重新验证。「重新验证」按钮仍会主动 clear（app-gate.js clearStepupThen）。
     从历史返回（bfcache）重新读一次状态。 */
  on(window, 'pageshow', function (/** @type {PageTransitionEvent} */ e) {
    if (e && e.persisted) {
      try { location.reload(); } catch (e2) {}
    }
  });

  probe();
})();
