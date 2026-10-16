/**
 * @fileoverview 安全与隐私页。
 * - 三个入口（访客与站长看到完全一样）：站长凭证、管理凭证、立即锁定。
 * - 站长凭证 → 共用验证弹层「进入站长凭证」→ 单个「根凭证」行 → /api/root-auth
 *   → 成功后直接进站长凭证门内页（/settings/security/owner/）。
 *   访客会话下为假入口（服务端写死 401），UI 与真入口完全一致。
 * - 管理凭证 → 共用验证弹层「进入管理凭证」→ 行按站长凭证配置（/api/owner-status）：
 *   未设置→根凭证（进站长凭证门）；仅通行密钥→站长通行密钥；
 *   仅密码→站长密码；两者都有→两个行（进锁屏门）。
 *   通行密钥行点后拉起系统验证；密码/根凭证行就地展开输入框。
 * - 立即锁定：调服务端 /api/lock 清除会话 cookie 后重载，回到锁屏。
 * - 从 /api/owner-status（需鉴权）读取只读状态，渲染状态卡片（访客不调用）。
 * - localStorage 统一走 storage.js。
 */
import { on } from '../lib/events.js';
import { get as storeGet } from '../lib/storage.js';
import { toast } from '../lib/toast.js';
import { followKeyboard } from '../shell/vk.js';
import { mgmtButtons } from './mgmt-buttons.js';
import { exchangeRootSession } from '../lib/root-session.js';
import { takeJumpRecords } from './app-gate.js';
import { takeBeaconRecord, sgxNavigate, sgxReload, recordJump } from '../lib/diag-jumptrace.js';
import { onDialogBackdrop, onDialogCancel, recordDialogClose, bindEyeButton, bindSubmitButton, tapFeedback, setRowBusy, setRowSelected, shouldIgnorePostDialogClick } from '../lib/dialog-behavior.js';

(function () {
  const en = document.documentElement.lang === 'en';
  /** @type {any} */
  let T = {};
  try {
    T = JSON.parse(document.getElementById('sgx-i18n-security').textContent || '{}');
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

  const ownerUrl = en ? '/en/settings/security/owner/' : '/settings/security/owner/';
  const mgmtUrl = en ? '/en/settings/security/mgmt/' : '/settings/security/mgmt/';

  const card = document.getElementById('sec-status');
  const cardTitle = document.getElementById('sec-status-title');
  const cardSub = document.getElementById('sec-status-sub');

  /**
   * 渲染状态。
   * @param {boolean} hasPw
   * @param {boolean} hasPk
   */
  function render(hasPw, hasPk) {
    if (card) {
      card.hidden = false;
      card.classList.toggle('is-ok', hasPw && hasPk);
      card.classList.toggle('is-warn', !(hasPw && hasPk));
    }
    if (hasPw && hasPk) {
      if (cardTitle) cardTitle.textContent = t('okTitle');
      if (cardSub) cardSub.textContent = t('okSub');
    } else {
      if (cardTitle) cardTitle.textContent = t('warnTitle');
      const miss = [];
      if (!hasPw) miss.push(t('missPw'));
      if (!hasPk) miss.push(t('missPk'));
      if (cardSub) cardSub.textContent = miss.join('，');
    }
  }

  /** @param {boolean} [silent] */
  function refresh(silent) {
    /* 访客不再调用 /api/owner-status（接口已加鉴权，访客 401）；状态卡片保持隐藏。 */
    try {
      if (document.documentElement.dataset.sgxRole === 'visitor') return;
    } catch (e) {}
    fetch('/api/owner-status', { method: 'GET', credentials: 'same-origin' })
      .then(function (r) {
        return r.json();
      })
      .then(function (j) {
        if (j && j.ok) {
          render(!!j.password, !!j.passkey);
          if (!silent) toast(t('refreshToast'));
        } else {
          throw new Error('bad');
        }
      })
      .catch(function () {
        /* 读取失败：保持现状 */
      });
  }

  /* B1-1 立即锁定：先弹确认层，确认后调服务端清除 sgx-verified，
     然后 location.replace('/?lock=1') → 锁屏出现（中间不渲染主页）。
     访客和站长都能用，不设限。 */
  const lockNow = document.getElementById('sec-locknow');
  if (lockNow) {
    const doLock = function () {
      fetch('/api/lock', { method: 'POST', credentials: 'include' })
        .then(function () {
          location.replace('/?lock=1');
        })
        .catch(function () {
          location.replace('/?lock=1');
        });
    };
    const showConfirm = function () {
      /* B1-1：弹层关闭后 400ms 内忽略点击（防误触） */
      if (shouldIgnorePostDialogClick()) return;
      let dlg = document.getElementById('sec-locknow-confirm');
      if (!dlg) {
        dlg = document.createElement('dialog');
        dlg.id = 'sec-locknow-confirm';
        dlg.className = 'sgx-verify-dlg';
        const en = document.documentElement.lang === 'en';
        dlg.innerHTML =
          '<div class="sgx-verify-card">' +
            '<div class="sheet-handle"></div>' +
            '<h2 class="sgx-verify-title">' + (en ? 'Lock now?' : '立即锁定？') + '</h2>' +
            '<p class="sgx-verify-desc">' + (en ? 'This device will return to the lock screen.' : '当前设备会回到锁屏。') + '</p>' +
            '<div class="sgx-door-foot" style="gap:12px;align-self:stretch">' +
              '<button type="button" class="sgx-door-btn sgx-door-btn-secondary" data-act="cancel">' + (en ? 'Cancel' : '取消') + '</button>' +
              '<button type="button" class="sgx-door-btn sgx-door-btn-primary" data-act="ok">' + (en ? 'Lock' : '锁定') + '</button>' +
            '</div>' +
          '</div>';
        document.body.appendChild(dlg);
        onDialogBackdrop(dlg, function () { dlg.close(); recordDialogClose('locknow-confirm', 'backdrop'); });
        onDialogCancel(dlg, function () { dlg.close(); recordDialogClose('locknow-confirm', 'cancel'); });
        dlg.querySelector('[data-act="cancel"]').addEventListener('click', function () {
          dlg.close();
          recordDialogClose('locknow-confirm', 'cancel-btn');
        });
        dlg.querySelector('[data-act="ok"]').addEventListener('click', function () {
          dlg.close();
          recordDialogClose('locknow-confirm', 'confirm');
          doLock();
        });
      }
      try { dlg.showModal(); } catch (e) {}
    };
    on(lockNow, 'click', showConfirm);
    on(lockNow, 'keydown', function (/** @type {KeyboardEvent} */ e) {
      /* B1-1：只认 Enter，删 Space */
      if (e.key === 'Enter') {
        e.preventDefault();
        showConfirm();
      }
    });
  }

  const more = document.getElementById('sec-more');
  if (more) {
    on(more, 'click', function () {
      refresh(false);
    });
  }

  /* 重置所有设置入口：跳回设置页关于分组（由设置页处理二次确认） */
  const resetLink = document.getElementById('sec-reset-link');
  if (resetLink) {
    on(resetLink, 'click', function () {
      try {
        storeGet('sgx-set-recent');
      } catch (e) {}
    });
  }

  /* ============ 两扇门验证弹层（共用组件，One UI 悬浮卡片） ============
     只传标题、说明和方式列表；只显示已配置的方式。
     - 点通行密钥行：右侧 > 变加载圈并拉起系统验证；用户取消系统验证时
       弹层保留、不提示错误。
     - 点密码/根凭证行：弹层内就地展开输入框（显示/隐藏、自动聚焦，
       根凭证用单行密码框（Samsung Pass 可填充），底部变为「取消」「验证」两个等宽文字按钮；
       不跳新页、不用原生 prompt。键盘弹出时弹层整体上移（followKeyboard）。
     - 出错在输入框下方红色小字说明原因，不用 toast，不说「服务器错误」。
     - 成功：弹层收起并直接进入门内页面，不再停留在入口页。
     界面不出现 stepup、票据、rootkey/ownerkey 等内部名。 */
  const doorDlg = (function () {
    const dlg = document.getElementById('sec-verify-dlg');
    const titleEl = document.getElementById('sec-verify-title');
    const descEl = document.getElementById('sec-verify-desc');
    const methodsEl = document.getElementById('sec-verify-methods');
    const footEl = document.getElementById('sec-verify-foot');
    if (!dlg || !titleEl || !methodsEl || !footEl) return null;

    const CHEV = '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M9 6l6 6-6 6"/></svg>';
    const ICONS = {
      passkey: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M12 3l7.5 3v5.25c0 4.6-3.2 7.9-7.5 9.75-4.3-1.85-7.5-5.15-7.5-9.75V6L12 3z"/><path stroke-linecap="round" stroke-linejoin="round" d="M9.5 12l2 2 3.5-4"/></svg>',
      password: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="4" y="11" width="16" height="10" rx="2"/><path stroke-linecap="round" stroke-linejoin="round" d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>',
      root: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="8" cy="16" r="4"/><path stroke-linecap="round" stroke-linejoin="round" d="M10.8 13.2L20 4m-3 3l3 3"/></svg>',
    };

    /** 当前展开的输入区（同一时刻只展开一个） */
    let expanded = null;

    /** @param {string} s */
    function b64ToBuf(s) {
      const bin = atob(String(s).replace(/-/g, '+').replace(/_/g, '/'));
      const u = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
      return u;
    }
    /** @param {ArrayBuffer|Uint8Array} buf */
    function bufToB64(buf) {
      const u = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
      let s = '';
      for (let i = 0; i < u.length; i++) s += String.fromCharCode(u[i]);
      return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    }
    /**
     * @param {string} url
     * @param {object} body
     */
    function postJSON(url, body) {
      return fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        credentials: 'same-origin',
      }).then(function (r) {
        return r.json().then(function (j) { return { s: r.status, j: j }; });
      });
    }

    function showErr(el, msg) {
      if (el) {
        el.textContent = msg;
        el.hidden = false;
      }
    }
    function closeDlg(reason) {
      recordDialogClose('sec-verify', reason || 'unknown');
      collapse();
      try { dlg.close(); } catch (e) {}
    }
    /** 当前展开行的行元素与箭头（collapse 时一并清除选中态 + 旋转） */
    let expandedRow = null;
    let expandedChev = null;
    function collapse() {
      if (expanded) {
        expanded.remove();
        expanded = null;
      }
      /* 批次 A 验收修复 P2：收起时清除行选中态 + 箭头旋转 */
      if (expandedRow) {
        setRowSelected(expandedRow, false);
        expandedRow = null;
      }
      if (expandedChev) {
        expandedChev.classList.remove('expanded');
        expandedChev = null;
      }
      setFootSingle();
    }
    function setFootSingle() {
      footEl.innerHTML = '';
      const c = document.createElement('button');
      c.type = 'button';
      /* C3：取消用圆角矩形浅底深蓝字按钮 */
      c.className = 'sgx-door-btn sgx-door-btn-secondary';
      c.textContent = en ? 'Cancel' : '取消';
      on(c, 'click', function () { closeDlg('cancel-btn'); });
      footEl.appendChild(c);
    }
    /** @param {() => void} onVerify */
    function setFootDouble(onVerify) {
      footEl.innerHTML = '';
      const wrap = document.createElement('div');
      wrap.className = 'sgx-door-actions';
      const cancel = document.createElement('button');
      cancel.type = 'button';
      /* C3：圆角矩形按钮，取消浅底深蓝字 */
      cancel.className = 'sgx-door-btn sgx-door-btn-secondary';
      cancel.textContent = en ? 'Cancel' : '取消';
      on(cancel, 'click', collapse);
      const go = document.createElement('button');
      go.type = 'button';
      /* C3：圆角矩形按钮，验证深蓝底白字 */
      go.className = 'sgx-door-btn sgx-door-btn-primary';
      go.textContent = en ? 'Verify' : '验证';
      /* 批次 A 收尾：pointerup（要求 pointerdown 也在按钮）+ click 兜底，去重只提交一次 */
      bindSubmitButton(go, onVerify);
      wrap.appendChild(cancel);
      wrap.appendChild(go);
      footEl.appendChild(wrap);
    }

    /* ---------- 三种验证方式的提交逻辑 ---------- */
    /** @param {string} value */
    function submitRootValue(value) {
      return postJSON('/api/root-auth', { key: value }).then(
        function (res) {
          const j = res.j;
          if (j && j.ok) {
            /* 已有 owner 会话时直接进门，不需换会话。
               只有无会话（访客+未配锁引导）才需调 /api/root-session 换站长会话，
               否则被 middleware 拦。 */
            let hasSession = false;
            try {
              hasSession = document.documentElement.dataset.sgxRole === 'owner';
            } catch (e) {}
            if (hasSession) {
              /* #1 诊断：有会话时先预检刚签发的 stepup 票据。
                 票有效才进门；无效则把接口、状态码、服务端 reason 留在弹层里，
                 不关弹层、不跳转，方便定位。不显示密钥或 Cookie 值。 */
              return postJSON('/api/stepup', { action: 'status' }).then(
                function (st) {
                  const sj = st.j;
                  if (sj && sj.ok && sj.valid) return;
                  const reason = (sj && sj.reason) || 'unknown';
                  throw {
                    message: (en ? 'Pre-check failed' : '预检未通过') +
                      '（POST /api/stepup → ' + st.s + '，' + reason + '）',
                  };
                },
                function () {
                  throw { message: en ? 'Network connection failed, please retry' : '网络连接失败，请重试' };
                }
              );
            }
            /* 无会话路径：先走原来的换会话流程，不做 stepup 预检
               （无会话时 middleware 对 /api/* 直接 401，预检必失败）。 */
            return exchangeRootSession().then(function (rs) {
              if (rs && rs.ok) return;
              throw { message: en ? 'Verification failed, please retry' : '验证失败，请重试' };
            });
          }
          if (res.s === 429) {
            throw { message: en ? 'Too many attempts, please try again in 15 minutes' : '尝试太多次，请 15 分钟后再试' };
          }
          /* 401（含访客假入口）：统一提示密码不正确 */
          throw { message: en ? 'Incorrect password' : '密码不正确', clear: true };
        },
        function () {
          throw { message: en ? 'Network connection failed, please retry' : '网络连接失败，请重试' };
        }
      );
    }
    /** @param {string} value */
    function submitPasswordValue(value) {
      return postJSON('/api/stepup', { action: 'verify-password', password: value }).then(
        function (res) {
          if (res.j && res.j.ok) return;
          throw { message: en ? 'Incorrect password' : '密码不正确', clear: true };
        },
        function () {
          throw { message: en ? 'Network connection failed, please retry' : '网络连接失败，请重试' };
        }
      );
    }
    function doPasskey() {
      if (!window.PublicKeyCredential) {
        return Promise.reject({ message: en ? 'Passkey not supported' : '不支持通行密钥' });
      }
      return postJSON('/api/stepup', { action: 'challenge' }).then(
        function (res) {
          const j = res.j;
          if (!j || !j.ok || !j.challenge) {
            throw { message: en ? 'Verification failed, please retry' : '验证失败，请重试' };
          }
          const allow = (j.allowCredentials || []).map(function (c) {
            return { type: 'public-key', id: b64ToBuf(c.id) };
          });
          return navigator.credentials
            .get({
              publicKey: {
                challenge: b64ToBuf(j.challenge),
                rpId: j.rpId,
                allowCredentials: allow.length ? allow : undefined,
                userVerification: 'required',
              },
            })
            .then(
              function (cred) { return { cred: cred, cid: j.cid }; },
              function (e) {
                /* 用户取消系统验证：调用方保留弹层、不提示错误 */
                if (e && e.name === 'NotAllowedError') throw { cancelled: true };
                throw { message: en ? 'Verification failed, please retry' : '验证失败，请重试' };
              }
            );
        },
        function () {
          throw { message: en ? 'Network connection failed, please retry' : '网络连接失败，请重试' };
        }
      ).then(function (r) {
        const cred = r.cred;
        return postJSON('/api/stepup', {
          action: 'verify',
          cid: r.cid,
          credential: {
            id: cred.id,
            rawId: bufToB64(cred.rawId),
            type: cred.type,
            response: {
              authenticatorData: bufToB64(cred.response.authenticatorData),
              clientDataJSON: bufToB64(cred.response.clientDataJSON),
              signature: bufToB64(cred.response.signature),
              userHandle: cred.response.userHandle ? bufToB64(cred.response.userHandle) : null,
            },
          },
        });
      }).then(
        function (res) {
          if (res.j && res.j.ok) return;
          throw { message: en ? 'Verification failed, please retry' : '验证失败，请重试' };
        },
        function (e) {
          if (e && (e.cancelled || e.message)) throw e;
          throw { message: en ? 'Network connection failed, please retry' : '网络连接失败，请重试' };
        }
      );
    }

    /* ---------- 行内展开 / 加载态 ---------- */
    /**
     * @param {object} m
     * @param {HTMLInputElement|HTMLTextAreaElement} input
     * @param {HTMLElement} errEl
     */
    function submitForm(m, input, errEl) {
      const v = input.value;
      errEl.hidden = true;
      if (!v) {
        showErr(errEl, en ? 'Enter credential' : '请输入凭证');
        return;
      }
      m.submit(v).then(
        function () {
          /* A3：根凭证 submit resolve 后、closeDlg 前记「root-resolved」 */
          if (m.kind === 'root') {
            try { recordJump('security.js:submitForm', 'root-resolved'); } catch (e) {}
          }
          closeDlg('success');
          /* A3：onSuccess 开头再记「root-onsuccess」 */
          if (m.kind === 'root') {
            try { recordJump('security.js:submitForm', 'root-onsuccess'); } catch (e) {}
          }
          m.onSuccess();
        },
        function (e) {
          showErr(errEl, e && e.message ? e.message : (en ? 'Verification failed, please retry' : '验证失败，请重试'));
          if (e && e.clear) input.value = '';
        }
      );
    }
    /**
     * @param {object} m
     * @param {HTMLElement} wrap
     * @param {HTMLElement} rowErr
     */
    function expandForm(m, wrap, rowErr, row, chev) {
      const wasOpen = !!(expanded && expanded.dataset.kind === m.kind);
      collapse();
      rowErr.hidden = true;
      if (wasOpen) return;
      const form = document.createElement('div');
      form.className = 'sgx-door-expand';
      form.dataset.kind = m.kind;
      const field = document.createElement('div');
      field.className = 'sgx-pw-field';
      let input;
      if (m.field === 'root') {
        /* 批次 A 收尾 B1：根凭证改单行密码框，autocomplete=current-password，
           配隐藏用户名字段（autocomplete=username，值 root），让 Samsung Pass 能填充。 */
        const userField = document.createElement('input');
        userField.type = 'text';
        userField.autocomplete = 'username';
        userField.value = 'root';
        userField.setAttribute('aria-hidden', 'true');
        userField.tabIndex = -1;
        userField.style.cssText = 'position:absolute;opacity:0;pointer-events:none;width:1px;height:1px;';
        field.appendChild(userField);
        input = document.createElement('input');
        input.type = 'password';
        input.className = 'sgx-pw-input';
        input.autocomplete = 'current-password';
      } else {
        input = document.createElement('input');
        input.type = 'password';
        input.className = 'sgx-pw-input';
        input.autocomplete = 'current-password';
      }
      input.setAttribute('aria-label', m.title);
      input.placeholder = m.sub;
      const eye = document.createElement('button');
      eye.type = 'button';
      eye.className = 'sgx-pw-eye';
      /* 批次 A 验收修复 P2：bindEyeButton 统一接管（初始 eye-off；expandForm 重建即复位） */
      bindEyeButton(eye, input, {
        showLabel: en ? 'Show password' : '显示密码',
        hideLabel: en ? 'Hide password' : '隐藏密码',
      });
      field.appendChild(input);
      field.appendChild(eye);
      const errEl = document.createElement('p');
      errEl.className = 'sgx-door-err';
      errEl.hidden = true;
      form.appendChild(field);
      form.appendChild(errEl);
      wrap.appendChild(form);
      expanded = form;
      /* 批次 A 验收修复 P2：展开时行选中态 + 箭头旋转 90° */
      if (row) {
        setRowSelected(row, true);
        expandedRow = row;
      }
      if (chev) {
        chev.classList.add('expanded');
        expandedChev = chev;
      }
      const doSubmit = function () { submitForm(m, input, errEl); };
      setFootDouble(doSubmit);
      /* 键盘弹出时弹层整体上移 */
      followKeyboard(dlg, input);
      try { input.focus({ preventScroll: true }); } catch (e) { try { input.focus(); } catch (_) {} }
      on(input, 'keydown', function (/** @type {KeyboardEvent} */ e) {
        if (e.key === 'Enter') {
          e.preventDefault();
          doSubmit();
        }
      });
    }
    /**
     * @param {object} m
     * @param {HTMLButtonElement} row
     * @param {HTMLElement} chev
     * @param {HTMLElement} rowErr
     */
    function startWebauthn(m, row, chev, rowErr) {
      /* 批次 A 验收修复 P2：busy 中重复点击（合成事件）直接丢弃，保证 challenge 只发一次 */
      if (row.disabled) return;
      rowErr.hidden = true;
      /* 副标题切换 busy 文案（保存原文，成功/取消/失败三路都要恢复） */
      const subEl = row.querySelector('.sgx-door-rowsub');
      const origSub = subEl ? subEl.textContent : '';
      if (subEl) subEl.textContent = t('passkeyBusy');
      chev.innerHTML = '<span class="sgx-door-spin" aria-hidden="true"></span>';
      setRowBusy(row, true);
      m.submit().then(
        function () {
          closeDlg('success');
          m.onSuccess();
        },
        function (e) {
          /* 用户取消系统验证：弹层保留，不提示错误 */
          if (!(e && e.cancelled)) {
            showErr(rowErr, e && e.message ? e.message : (en ? 'Verification failed, please retry' : '验证失败，请重试'));
          }
        }
      ).then(function () {
        chev.innerHTML = CHEV;
        setRowBusy(row, false);
        if (subEl) subEl.textContent = origSub;
      });
    }
    /** @param {object} m */
    function renderMethod(m) {
      const wrap = document.createElement('div');
      wrap.className = 'sgx-door-method';
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'sgx-door-row';
      const ic = document.createElement('span');
      ic.className = 'sgx-door-ic';
      ic.setAttribute('aria-hidden', 'true');
      ic.innerHTML = m.icon;
      const mid = document.createElement('span');
      mid.className = 'sgx-door-mid';
      const rt = document.createElement('span');
      rt.className = 'sgx-door-rowtitle';
      rt.textContent = m.title;
      const rs = document.createElement('span');
      rs.className = 'sgx-door-rowsub';
      rs.textContent = m.sub;
      mid.appendChild(rt);
      mid.appendChild(rs);
      const chev = document.createElement('span');
      chev.className = 'sgx-door-chev';
      chev.setAttribute('aria-hidden', 'true');
      chev.innerHTML = CHEV;
      row.appendChild(ic);
      row.appendChild(mid);
      row.appendChild(chev);
      const rowErr = document.createElement('p');
      rowErr.className = 'sgx-door-err';
      rowErr.hidden = true;
      wrap.appendChild(row);
      wrap.appendChild(rowErr);
      methodsEl.appendChild(wrap);
      on(row, 'click', function () {
        /* 批次 A 验收修复 P2：轻触觉反馈 */
        tapFeedback();
        if (m.field === 'webauthn') startWebauthn(m, row, chev, rowErr);
        else expandForm(m, wrap, rowErr, row, chev);
      });
    }

    /* ---------- 方式定义 ---------- */
    /** @param {() => void} onSuccess */
    function rootMethod(onSuccess) {
      return {
        kind: 'root', field: 'root', icon: ICONS.root,
        title: en ? 'Root credential' : '根凭证',
        sub: en ? 'Paste or enter root credential' : '粘贴或输入根凭证',
        submit: submitRootValue, onSuccess: onSuccess,
      };
    }
    /** @param {() => void} onSuccess */
    function passwordMethod(onSuccess) {
      return {
        kind: 'password', field: 'password', icon: ICONS.password,
        title: en ? 'Owner password' : '站长密码',
        sub: en ? 'Enter owner password' : '输入站长密码',
        submit: submitPasswordValue, onSuccess: onSuccess,
      };
    }
    /** @param {() => void} onSuccess */
    function passkeyMethod(onSuccess) {
      return {
        kind: 'passkey', field: 'webauthn', icon: ICONS.passkey,
        title: en ? 'Owner passkey' : '站长通行密钥',
        sub: en ? 'Use fingerprint or device screen lock' : '使用指纹或设备锁屏',
        submit: doPasskey, onSuccess: onSuccess,
      };
    }

    /**
     * @param {object} cfg {title, desc, methods, loadError?}
     */
    function open(cfg) {
      titleEl.textContent = cfg.title;
      descEl.textContent = cfg.desc;
      methodsEl.innerHTML = '';
      collapse();
      if (cfg.loadError) {
        const p = document.createElement('p');
        p.className = 'sgx-door-err';
        p.textContent = cfg.loadError;
        methodsEl.appendChild(p);
      } else {
        cfg.methods.forEach(renderMethod);
      }
      if (typeof dlg.showModal === 'function') {
        try { dlg.showModal(); } catch (e) {}
      }
    }

    /* 批次 A 收尾 A1/A2：点遮罩只失焦不关闭；返回手势键盘开着先收键盘，键盘收起才关闭 */
    dlg.addEventListener('click', function (e) {
      onDialogBackdrop(e, dlg);
    });
    dlg.addEventListener('cancel', function (e) {
      onDialogCancel(e, dlg, function (reason) { closeDlg(reason); });
    });
    /* 批次 A 收尾 A3：右上角 × 按钮 */
    const closeBtn = document.getElementById('sec-verify-close');
    if (closeBtn) {
      on(closeBtn, 'click', function () { closeDlg('close-btn'); });
    }

    return { open: open, rootMethod: rootMethod, passwordMethod: passwordMethod, passkeyMethod: passkeyMethod };
  })();

  /* ============ 入口 1：站长凭证 ============
     弹层「进入站长凭证」，单个「根凭证」行 → /api/root-auth →
     成功后直接进站长凭证门内页。访客会话下服务端为假入口（写死 401），
     UI 完全一致。 */
  (function () {
    const row = document.getElementById('sec-owner-cred');
    if (!row || !doorDlg) return;
    function openOwnerDoor() {
      doorDlg.open({
        title: en ? 'Enter owner key' : '进入站长凭证',
        desc: en
          ? 'Verify with your root credential. After verification you can freely manage owner keys; it expires when you leave.'
          : '用根凭证验证。验证后可自由管理站长凭证，离开即失效。',
        methods: [doorDlg.rootMethod(function () { sgxNavigate(ownerUrl, 'security.js:588', 'root-ok'); })],
      });
    }
    on(row, 'click', openOwnerDoor);
    on(row, 'keydown', function (/** @type {KeyboardEvent} */ e) {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        openOwnerDoor();
      }
    });
  })();

  /* ============ 入口 2：管理凭证 ============
     弹层「进入管理凭证」，行按站长凭证配置（/api/owner-status）：
     - 什么都没设置 → 只显示「根凭证」（进管理凭证索引页）
     - 只设了通行密钥 → 「站长通行密钥」
     - 只设了密码 → 「站长密码」
     - 两个都设了 → 两个都显示（进管理凭证索引页），不显示根凭证
     批次 A 收尾 D1：通行密钥和密码验证成功都走 goMgmt（进管理凭证索引页），
     不再 goLock 直接进锁屏子页。
     访客会话下为假入口——弹层固定单个「根凭证」行，不读站长凭证配置；
     服务端（/api/root-auth 访客假入口）写死返回密码错误。 */
  (function () {
    const row = document.getElementById('sec-mgmt-cred');
    if (!row || !doorDlg) return;
    /* 定稿 #16：未配 ownerkey 时管理凭证的根凭证行验证后进管理凭证索引页，
       不跳站长凭证门。 */
    const goMgmt = function () { sgxNavigate(mgmtUrl, 'security.js:613', 'mgmt-door-ok'); };
    function openMgmtDoor() {
      let isVisitor = false;
      try {
        isVisitor = document.documentElement.dataset.sgxRole === 'visitor';
      } catch (e) {}
      const title = en ? 'Enter credential management' : '进入管理凭证';
      const desc = en
        ? 'Verify with your owner credential. After verification you can freely manage lock screen and app keys; it expires when you leave.'
        : '用站长凭证验证。验证后可自由管理锁屏和应用的钥匙，离开即失效。';
      const build = function (hasPw, hasPk) {
        const methods = [];
        /* 行决策走纯函数 mgmtButtons（可测试），与 /api/owner-status 的语义对齐 */
        const kinds = mgmtButtons(hasPw, hasPk);
        for (const kind of kinds) {
          if (kind === 'root') methods.push(doorDlg.rootMethod(goMgmt));
          else if (kind === 'passkey') methods.push(doorDlg.passkeyMethod(goMgmt));
          else if (kind === 'password') methods.push(doorDlg.passwordMethod(goMgmt));
        }
        doorDlg.open({ title: title, desc: desc, methods: methods });
      };
      if (isVisitor) {
        build(false, false);
      } else {
        /* 每次打开时重新读取配置。读取失败显示错误，不退回根凭证
           （避免显示必然失败的行）。 */
        fetch('/api/owner-status', { method: 'GET', credentials: 'same-origin' })
          .then(function (r) { return r.json(); })
          .then(function (j) {
            if (j && j.ok) build(!!j.password, !!j.passkey);
            else throw new Error('bad');
          })
          .catch(function () {
            doorDlg.open({
              title: title, desc: desc, methods: [],
              loadError: en ? 'Failed to load configuration' : '读取配置失败，请重试',
            });
          });
      }
    }
    on(row, 'click', openMgmtDoor);
    on(row, 'keydown', function (/** @type {KeyboardEvent} */ e) {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        openMgmtDoor();
      }
    });
  })();


  /* #1 诊断：门内页跳转留痕。安全页加载时若有记录则全部显示（取即清除）。 */
  (function () {
    let jrs = [];
    try {
      jrs = takeJumpRecords();
    } catch (e) {}
    let bc = null;
    try {
      bc = takeBeaconRecord();
    } catch (e) {}
    if (!jrs.length && !bc) return;
    const note = document.getElementById('sgx-jump-note');
    const txt = document.getElementById('sgx-jump-note-text');
    if (!note || !txt) return;
    const parts = [];
    if (bc) {
      parts.push((en ? 'Door page loaded: ' : '门内页已加载：') + bc.path +
        '（session=' + bc.session + ',role=' + bc.role +
        ',upgrade=' + bc.upgrade + ',build=' + bc.build + '）');
    }
    /* A5：最近 5 条全部显示，每条带桌面版标记 + visibilityState */
    jrs.forEach(function (jr, i) {
      const meta = [];
      if (typeof jr.desktop === 'boolean') meta.push(jr.desktop ? (en ? 'desktop' : '桌面版') : (en ? 'mobile' : '手机版'));
      if (jr.visibility) meta.push(jr.visibility);
      parts.push((en ? 'Last door redirect ' + (i + 1) + ': ' : '上次门内跳转' + (i + 1) + '：') +
        jr.who + (jr.reason ? '（' + jr.reason + '）' : '') +
        (meta.length ? ' [' + meta.join(',') + ']' : ''));
    });
    txt.textContent = parts.join(en ? ' | ' : '；');
    note.hidden = false;
  })();

  refresh(true);
})();
