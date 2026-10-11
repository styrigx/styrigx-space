/**
 * @fileoverview 锁定屏幕管理页（2.4.0 安全与隐私，替代 /owner/）。
 * - 进入前底部弹层「验证身份」：使用通行密钥 / 使用根密钥（无通行密钥时只显示根密钥）；
 *   解锁密码不能进入此页。
 * - 验证后：解锁密码（弹层设置/修改，双输入框竖排，显示/隐藏，最少 8 位）；
 *   通行密钥列表（设备名可编辑、注册日期、可删除），底部「添加通行密钥」。
 * - 反馈一律 One UI 轻提示（toast）；localStorage 经 storage.js。
 */
import { on } from '../lib/events.js';
import { toast } from '../lib/toast.js';

(function () {
  const en = document.documentElement.lang === 'en';
  /** @type {any} */
  let T = {};
  try {
    T = JSON.parse(document.getElementById('sgx-i18n-lockmgr').textContent || '{}');
  } catch (e) {}
  /** @param {string} k */
  function t(k) {
    const v = T[k];
    if (v && typeof v === 'object') return en ? v.en : v.zh;
    return v || k;
  }
  /** @param {string} id */
  function $(id) {
    return document.getElementById(id);
  }

  /** 管理 token（验证后签发，只存内存）
      2.10.0：已废弃，管理操作改用 sgx-stepup cookie（服务端 HttpOnly）。
      保留变量避免引用错误，但不再使用。 */
  let token = null;
  let hasPw = false;
  /** 2.10.0：全量通行密钥缓存（含应用类，供应用验证分组渲染） */
  let allKeys = [];
  /** 2.10.0：应用白名单（与服务端一致，book 在列） */
  var APPS = [{ aud: 'book', name: 'Book' }];

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
  /**
   * 统一解析 API 响应：{ status, json }，区分网络错误/服务器错误/业务错误。
   * @param {Response} r
   */
  function parseApi(r) {
    return r.text().then(function (txt) {
      let j = null;
      try {
        j = JSON.parse(txt);
      } catch (e) {}
      return { status: r.status, json: j };
    });
  }
  /** @param {string} url @param {any} body @param {boolean} [retried] */
  function api(url, body, retried) {
    return fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      credentials: 'include',
    }).then(parseApi).then(function (res) {
      /* 2.10.0：stepup-required → 自动做一次 stepup 验证后重试（只重试一次）。
         2.10.1 A4：自动 stepup 失败时停在错误提示，不自动重开验证门。
         补充指令 3：保留服务端的 reason（bad-sig/expired/epoch-changed 等）供显示。 */
      if (!retried && res.json && res.json.error === 'stepup-required') {
        const serverReason = res.json.reason;
        return doStepup().then(function (r) {
          if (r.ok) return api(url, body, true);
          /* 失败：返回带错误码的响应，调用方显示错误并停住 */
          const errCode = r.error || 'stepup-failed';
          console.error('[api] stepup failed:', errCode, 'server reason:', serverReason);
          return { status: res.status, json: { ok: false, error: errCode, reason: serverReason } };
        });
      }
      return res;
    });
  }

  /**
   * 2.10.0：执行 stepup 验证（锁屏类通行密钥，强制 UV）。
   * 成功后服务端设置 sgx-stepup cookie。
   * 2.10.1 A3：返回 { ok, error }，失败时带服务端错误码。
   * @returns {Promise<{ok:boolean, error?:string}>}
   */
  function doStepup() {
    if (!window.PublicKeyCredential) {
      return Promise.resolve({ ok: false, error: 'no-support' });
    }
    let lastError = 'server';
    return api('/api/stepup', { action: 'challenge' })
      .then(function (res) {
        const ch = res.json;
        if (!ch || !ch.ok) {
          lastError = (ch && ch.error) || 'server';
          throw { kind: 'server' };
        }
        const allow = (ch.allowCredentials || []).map(function (c) {
          return { id: b64urlToBuf(c.id), type: c.type };
        });
        return navigator.credentials
          .get({ publicKey: { challenge: b64urlToBuf(ch.challenge), rpId: ch.rpId, allowCredentials: allow, userVerification: 'required', timeout: 60000 } })
          .then(function (cred) {
            return { cred: cred, cid: ch.cid };
          }, function (e) {
            lastError = e && e.name === 'NotAllowedError' ? 'cancelled' : 'failed';
            throw { kind: lastError };
          });
      })
      .then(function (r2) {
        const cred = r2.cred;
        return fetch('/api/stepup', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            action: 'verify',
            cid: r2.cid,
            credential: {
              id: cred.id,
              rawId: bufToB64url(cred.rawId),
              type: cred.type,
              response: {
                clientDataJSON: bufToB64url(cred.response.clientDataJSON),
                authenticatorData: bufToB64url(cred.response.authenticatorData),
                signature: bufToB64url(cred.response.signature),
                userHandle: cred.response.userHandle ? bufToB64url(cred.response.userHandle) : null,
              },
            },
          }),
          credentials: 'include',
        }).then(parseApi);
      })
      .then(function (res) {
        if (res.json && res.json.ok) return { ok: true };
        lastError = (res.json && res.json.error) || 'verify';
        return { ok: false, error: lastError };
      })
      .catch(function (e) {
        return { ok: false, error: lastError };
      });
  }
  /** @param {string} s */
  function b64urlToBuf(s) {
    s = s.replace(/-/g, '+').replace(/_/g, '/');
    const bin = atob(s);
    const u8 = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
    return u8;
  }
  /** @param {ArrayBuffer} buf */
  function bufToB64url(buf) {
    const u8 = new Uint8Array(buf);
    let s = '';
    for (let i = 0; i < u8.length; i++) s += String.fromCharCode(u8[i]);
    return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }
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
  /** token 失效 → 重新验证 */
  function needReauth() {
    token = null;
    toast(t('sessExp'));
    openGate();
  }

  /* ---------- 验证身份弹层 ---------- */
  const gateDlg = $('lockgate-dlg');
  const gateOpts = $('lockgate-opts');
  const gateKeyForm = $('lockgate-keyform');
  const gatePkBtn = $('lockgate-pk');
  const gateKeyBtn = $('lockgate-key');
  const gateInput = $('lockgate-input');
  const gateEye = $('lockgate-eye');

  function openGate() {
    $('lockmgr').hidden = true;
    gateOpts.hidden = false;
    gateKeyForm.hidden = true;
    hideErr('lockgate-err');
    if (gateInput) gateInput.value = '';
    /* 有通行密钥才显示该选项；配置缺失时禁用 */
    fetch('/api/owner-status', { method: 'GET', credentials: 'same-origin' })
      .then(function (r) {
        return r.json();
      })
      .then(function (j) {
        if (gatePkBtn) gatePkBtn.hidden = !(j && j.ok && j.passkey);
        /* 检查通行密钥服务是否可用（SGX_RP_ID/SGX_ORIGIN 未配时禁用） */
        return fetch('/api/owner-passkey', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'challenge', type: 'auth' }),
        });
      })
      .then(function (r) {
        if (!r) return;
        return r.json().then(function (j) {
          if (j && j.error === 'config') {
            /* 服务端未配置：禁用所有通行密钥入口 */
            if (gatePkBtn) gatePkBtn.hidden = true;
            const pkAdd = $('lockmgr-pkadd');
            if (pkAdd) pkAdd.disabled = true;
            const pkSection = $('lockmgr-pklist');
            if (pkSection) pkSection.hidden = true;
          }
        });
      })
      .catch(function () {
        if (gatePkBtn) gatePkBtn.hidden = true;
      });
    try {
      gateDlg.showModal();
    } catch (e) {}
  }
  function closeGate() {
    try {
      if (gateDlg.open) gateDlg.close();
    } catch (e) {}
  }
  function enterMgr() {
    closeGate();
    /* 本页有独立验证门；进管理区时去掉全局锁屏遮罩，避免盖住按钮 */
    try {
      const gl = document.getElementById('sgx-lock');
      if (gl) gl.remove();
      document.body.classList.remove('sgx-locked');
    } catch (e) {}
    $('lockmgr').hidden = false;
    refreshStatus();
    refreshPkList();
  }

  if (gateDlg) {
    on(gateDlg, 'click', function (/** @type {MouseEvent} */ e) {
      const el = /** @type {Element|null} */ (e.target);
      if (el && el.closest && el.closest('[data-gclose]')) {
        /* 验证身份弹层不允许直接关闭：返回上一页 */
        history.back();
      }
    });
    on(gateDlg, 'cancel', function (/** @type {Event} */ e) {
      e.preventDefault();
      history.back();
    });
  }
  /* 显示/隐藏眼睛 */
  function bindEye(btn, input) {
    if (!btn || !input) return;
    btn.innerHTML =
      '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z"/><circle cx="12" cy="12" r="3"/></svg>';
    on(btn, 'click', function () {
      const show = input.type === 'password';
      input.type = show ? 'text' : 'password';
      btn.setAttribute('aria-label', show ? t('eyeHide') : t('eyeShow'));
      btn.classList.toggle('off', !show);
    });
  }
  bindEye(gateEye, gateInput);
  document.querySelectorAll('[data-eye]').forEach(function (b) {
    const inp = $(b.getAttribute('data-eye'));
    bindEye(b, inp);
  });

  /* 使用根密钥 → 显示输入框 */
  if (gateKeyBtn) {
    on(gateKeyBtn, 'click', function () {
      gateOpts.hidden = true;
      gateKeyForm.hidden = false;
      hideErr('lockgate-err');
      if (gateInput) {
        try {
          gateInput.focus({ preventScroll: true });
        } catch (e) {}
      }
    });
  }
  const gateBack = $('lockgate-back');
  if (gateBack) {
    on(gateBack, 'click', function () {
      gateKeyForm.hidden = true;
      gateOpts.hidden = false;
      hideErr('lockgate-err');
    });
  }
  function submitGateKey() {
    const k = gateInput ? gateInput.value : '';
    hideErr('lockgate-err');
    if (!k) {
      showErr('lockgate-err', t('gateNeedKey'));
      return;
    }
    /* 2.11：根密钥 = 根恢复凭据。/api/root-auth 通过后服务端只签发
       sgx-stepup(by=root, scope=root) cookie（不签发会话），前端直接进管理区。 */
    api('/api/root-auth', { key: k })
      .then(function (res) {
        const j = res.json;
        if (!j) {
          showErr('lockgate-err', t('gateSrvErr'));
          return;
        }
        if (j.ok) {
          enterMgr();
        } else if (j.error === 'locked') {
          showErr('lockgate-err', t('gateLocked'));
          console.error('[gate-key] rate limited');
        } else {
          /* 2.10.1 A3：显示服务端错误码 */
          showErr('lockgate-err', t('gateKeyWrong') + (j.error ? ' (' + j.error + ')' : ''));
          console.error('[gate-key] failed:', j.error);
        }
      })
      .catch(function () {
        showErr('lockgate-err', t('gateNetErr'));
      });
  }
  const gateGo = $('lockgate-go');
  if (gateGo) on(gateGo, 'click', submitGateKey);
  if (gateInput) {
    on(gateInput, 'keydown', function (/** @type {KeyboardEvent} */ e) {
      if (e.key === 'Enter') {
        e.preventDefault();
        submitGateKey();
      }
    });
  }

  /* 使用通行密钥 → 2.10.0：走 stepup 验证（锁屏类，强制 UV），成功后服务端设 cookie */
  if (gatePkBtn) {
    on(gatePkBtn, 'click', function () {
      hideErr('lockgate-err');
      if (!window.PublicKeyCredential) {
        showErr('lockgate-err', t('pkNoSupport'));
        return;
      }
      doStepup().then(function (r) {
        if (r.ok) {
          enterMgr();
        } else {
          /* 2.10.1 A3：显示服务端错误码 */
          showErr('lockgate-err', t('gatePkErr') + (r.error ? ' (' + r.error + ')' : ''));
          console.error('[gate-pk] stepup failed:', r.error);
        }
      });
    });
  }

  /* ---------- 管理区 ---------- */
  var hasPk = false;
  function refreshStatus() {
    fetch('/api/owner-status', { method: 'GET', credentials: 'same-origin' })
      .then(function (r) {
        return r.json();
      })
      .then(function (j) {
        hasPw = !!(j && j.ok && j.password);
        hasPk = !!(j && j.ok && j.passkey);
        const sub = $('lockmgr-pwsub');
        if (sub) sub.textContent = hasPw ? t('pwSet') : t('pwUnset');
        const title = $('lockpw-title');
        if (title) title.textContent = hasPw ? t('changeTitle') : t('setTitle');
        const delWrap = $('lockmgr-pwdel-wrap');
        if (delWrap) delWrap.hidden = !hasPw;
      })
      .catch(function () {});
  }

  /* 密码弹层 */
  const pwDlg = $('lockpw-dlg');
  function openPwDlg() {
    hideErr('lockpw-err');
    const a = $('lockpw-1'), b = $('lockpw-2');
    if (a) {
      a.value = '';
      a.type = 'password';
    }
    if (b) {
      b.value = '';
      b.type = 'password';
    }
    const title = $('lockpw-title');
    if (title) title.textContent = hasPw ? t('changeTitle') : t('setTitle');
    try {
      pwDlg.showModal();
    } catch (e) {}
    if (a) {
      try {
        a.focus({ preventScroll: true });
      } catch (e2) {}
    }
  }
  function closePwDlg() {
    try {
      if (pwDlg.open) pwDlg.close();
    } catch (e) {}
  }
  if (pwDlg) {
    on(pwDlg, 'click', function (/** @type {MouseEvent} */ e) {
      const el = /** @type {Element|null} */ (e.target);
      if (el === pwDlg || (el && el.closest && el.closest('[data-pclose]'))) closePwDlg();
    });
    on(pwDlg, 'cancel', function (/** @type {Event} */ e) {
      e.preventDefault();
      closePwDlg();
    });
  }
  const pwRow = $('lockmgr-pwrow');
  if (pwRow) {
    const go = function () {
      /* 2.10.1：不再检查 token（已废弃）；后端用 cookie 鉴权，api() 自动处理 stepup */
      openPwDlg();
    };
    on(pwRow, 'click', go);
    on(pwRow, 'keydown', function (/** @type {KeyboardEvent} */ e) {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        go();
      }
    });
  }
  /* 删除解锁密码（两步确认） */
  const pwDel = $('lockmgr-pwdel');
  if (pwDel) {
    let armed = false;
    let armTimer = 0;
    const origText = pwDel.textContent;
    on(pwDel, 'click', function () {
      /* 2.10.1：不再检查 token；后端用 cookie 鉴权 */
      if (!armed) {
        armed = true;
        /* 如果删完后密码和通行密钥都没了，提示只能用根密钥进入 */
        if (!hasPk) {
          pwDel.textContent = t('pwDelWarn');
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
      api('/api/owner-password', { action: 'remove' })
        .then(function (r) {
          const j = r.json;
          if (j && j.ok) {
            toast(t('pwDeleted'));
            /* 服务端删除成功后重新读状态刷新（KV 最终一致，边缘节点最多约 60 秒） */
            refreshStatus();
            refreshPkList();
          } else if (j && j.error === 'stepup-required') {
            needReauth();
          } else {
            toast(t('gateSrvErr'));
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
    });
  }
  /* 立即锁定并退出所有设备（2.8.0：独立 L2 API /api/lock-all-devices，只认 owner 会话） */
  const lockoutBtn = $('lockmgr-lockout');
  if (lockoutBtn) {
    on(lockoutBtn, 'click', function () {
      if (!token) {
        needReauth();
        return;
      }
      api('/api/lock-all-devices', {})
        .then(function (r) {
          const j = r.json;
          if (j && j.ok) {
            /* 服务端已用 Set-Cookie 清掉 cookie；清内存 token，跳回锁屏 */
            token = null;
            try { sessionStorage.removeItem('sgx-lockmgr'); } catch (e) {}
            location.href = '/?lock=1';
          } else if (j && (j.error === 'stepup-required' || r.status === 401)) {
            needReauth();
          } else {
            toast(t('gateSrvErr'));
          }
        })
        .catch(function () {
          toast(t('gateNetErr'));
        });
    });
  }
  function submitPw() {
    const a = $('lockpw-1'), b = $('lockpw-2');
    const va = a ? a.value : '', vb = b ? b.value : '';
    hideErr('lockpw-err');
    if (va.length < 8) {
      showErr('lockpw-err', t('pwMin8'));
      return;
    }
    if (va !== vb) {
      showErr('lockpw-err', t('pwMismatch'));
      return;
    }
    if (!token) {
      needReauth();
      return;
    }
    const action = hasPw ? 'change' : 'set';
    const body = action === 'set'
      ? { action: 'set', password: va }
      : { action: 'change', newPassword: va };
    api('/api/owner-password', body)
      .then(function (res) {
        const j = res.json;
        if (!j) {
          showErr('lockpw-err', t('gateSrvErr'));
          return;
        }
        if (j.ok) {
          closePwDlg();
          hasPw = true;
          refreshStatus();
          toast(hasPw && action === 'change' ? t('pwChanged') : t('pwSaved'));
        } else if (j.error === 'stepup-required') {
          closePwDlg();
          needReauth();
        } else if (j.error === 'exists' && action === 'set') {
          /* 并发已设置 → 改走 change */
          hasPw = true;
          refreshStatus();
          showErr('lockpw-err', t('pwMin8'));
        } else {
          showErr('lockpw-err', t('gateSrvErr'));
        }
      })
      .catch(function () {
        showErr('lockpw-err', t('gateNetErr'));
      });
  }
  const pwGo = $('lockpw-go');
  if (pwGo) on(pwGo, 'click', submitPw);

  /* 通行密钥命名弹层 */
  let pkNameCredId = null;
  let pkNamePrefill = '';
  /* 生成预填名：<密码管理器> · <设备>（注册前调用，随 register 一起提交） */
  function genPkPrefillName() {
    let device = '';
    try {
      if (navigator.userAgentData && navigator.userAgentData.platform) {
        device = navigator.userAgentData.platform;
      }
    } catch (e) {}
    /* provider 此时未知（服务端识别 AAGUID 后才知道），先只用设备名 */
    return device || '通行密钥';
  }
  function openPkNameDlg(credId, prefill) {
    pkNameCredId = credId;
    pkNamePrefill = prefill || '';
    const dlg = $('lockpkname-dlg');
    const input = $('lockpkname-input');
    if (!dlg || !input) return;
    input.value = pkNamePrefill;
    /* 异步补设备型号（userAgentData 高熵值） */
    try {
      if (navigator.userAgentData && navigator.userAgentData.getHighEntropyValues) {
        navigator.userAgentData.getHighEntropyValues(['model']).then(function (ua) {
          if (ua && ua.model && input && !input.value) {
            input.value = ua.model;
            pkNamePrefill = ua.model;
          }
        }).catch(function () {});
      }
    } catch (e) {}
    hideErr('lockpkname-err');
    try { dlg.showModal(); } catch (e) {}
    try { input.focus({ preventScroll: true }); } catch (e2) {}
  }
  function closePkNameDlg() {
    const dlg = $('lockpkname-dlg');
    try { if (dlg && dlg.open) dlg.close(); } catch (e) {}
    pkNameCredId = null;
    pkNamePrefill = '';
  }
  const pkNameSave = $('lockpkname-save');
  if (pkNameSave) {
    on(pkNameSave, 'click', function () {
      const input = $('lockpkname-input');
      let name = input ? input.value : '';
      /* 清理：去首尾空格和控制字符 */
      name = String(name).replace(/[\x00-\x1F\x7F]/g, '').trim().slice(0, 40);
      if (!name) {
        showErr('lockpkname-err', t('pkNameEmpty'));
        return;
      }
      if (!pkNameCredId || !token) {
        closePkNameDlg();
        return;
      }
      /* 没改名就不调 rename（注册时已带预填名） */
      if (name === pkNamePrefill) {
        toast(t('pkRegistered'));
        closePkNameDlg();
        refreshPkList();
        return;
      }
      api('/api/owner-passkey', { action: 'rename', credId: pkNameCredId, name: name })
        .then(function (r) {
          const j = r.json;
          if (j && j.ok) {
            toast(t('pkRegistered'));
            closePkNameDlg();
            refreshPkList();
          } else if (j && j.error === 'stepup-required') {
            needReauth();
          } else if (j && j.error === 'not-found') {
            /* KV 最终一致：刚注册的 key 可能暂时读不到 */
            showErr('lockpkname-err', t('pkRetryLater'));
          } else if (!j) {
            showErr('lockpkname-err', t('gateNetErr'));
          } else {
            showErr('lockpkname-err', t('gateSrvErr'));
          }
        })
        .catch(function () {
          showErr('lockpkname-err', t('gateNetErr'));
        });
    });
  }
  const pkNameSkip = $('lockpkname-skip');
  if (pkNameSkip) {
    on(pkNameSkip, 'click', function () {
      /* 跳过：用预填名（已在注册时设为默认值） */
      closePkNameDlg();
      toast(t('pkRegistered'));
      refreshPkList();
    });
  }

  /* 通行密钥列表（2.10.0：只显示锁屏类；应用类在应用验证分组） */
  function refreshPkList() {
    const ul = $('lockmgr-pklist');
    const empty = $('lockmgr-pkempty');
    api('/api/owner-passkey', { action: 'list' })
      .then(function (res) {
        const j = res.json;
        if (!j) return;
        if (j.error === 'stepup-required') {
          needReauth();
          return;
        }
        const keys = ((j.ok && j.keys) || []).filter(function (k) { return (k.class || 'lock') === 'lock'; });
        if (!ul) return;
        ul.innerHTML = '';
        // 缓存全量 keys 供应用验证分组使用
        allKeys = (j.ok && j.keys) || [];
        renderAppList();
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
            api('/api/owner-passkey', { action: 'rename', credId: k.credId, name: v })
              .then(function (r2) {
                const jj = r2.json;
                if (jj && jj.ok) {
                  lastSaved = v;
                  toast(t('pkRenamed'));
                } else if (jj && jj.error === 'stepup-required') {
                  needReauth();
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
            api('/api/owner-passkey', { action: 'delete', credId: k.credId })
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
                } else if (jj && jj.error === 'stepup-required') {
                  needReauth();
                } else if (jj && jj.error === 'not-found') {
                  toast(t('pkRetryLater'));
                } else if (!jj) {
                  toast(t('gateNetErr'));
                } else {
                  toast(t('gateSrvErr'));
                }
              })
              .catch(function () {
                toast(t('gateNetErr'));
              });
          });
          li.appendChild(nameWrap);
          li.appendChild(del);
          ul.appendChild(li);
        });
        ul.hidden = keys.length === 0;
        if (empty) empty.hidden = keys.length !== 0;
      })
      .catch(function () {});
  }

  /* 2.10.0：应用验证分组（每应用一行，可单独添加/删除钥匙；增删先过 stepup） */
  function renderAppList() {
    const ul = $('lockmgr-applist');
    if (!ul) return;
    ul.innerHTML = '';
    APPS.forEach(function (app) {
      const appKeys = allKeys.filter(function (k) {
        return (k.class || 'lock') === 'app' && k.aud === app.aud;
      });
      const li = document.createElement('li');
      li.className = 'lockmgr-pkitem';
      const nameWrap = document.createElement('div');
      nameWrap.className = 'lockmgr-pkname';
      const label = document.createElement('span');
      label.textContent = app.name + (appKeys.length ? '（' + appKeys.length + '）' : '（未添加）');
      nameWrap.appendChild(label);
      li.appendChild(nameWrap);
      const btnWrap = document.createElement('div');
      if (appKeys.length === 0) {
        const add = document.createElement('button');
        add.type = 'button';
        add.className = 'lockmgr-add';
        add.textContent = '＋ 添加' + app.name + '的钥匙';
        on(add, 'click', function () {
          addAppKey(app.aud);
        });
        btnWrap.appendChild(add);
      } else {
        appKeys.forEach(function (k) {
          const del = document.createElement('button');
          del.type = 'button';
          del.className = 'lockmgr-del';
          del.textContent = '删除';
          del.setAttribute('aria-label', '删除' + app.name + '的钥匙');
          on(del, 'click', function () {
            if (!confirm(t('pkDelConfirm') || '确定删除？')) return;
            api('/api/owner-passkey', { action: 'delete', credId: k.credId })
              .then(function (r2) {
                if (r2.json && r2.json.ok) {
                  toast(t('pkDeleted') || '已删除');
                  refreshPkList();
                }
              })
              .catch(function () {});
          });
          btnWrap.appendChild(del);
        });
      }
      li.appendChild(btnWrap);
      ul.appendChild(li);
    });
  }

  /* 2.10.0：添加应用类通行密钥（aud 必须在白名单；服务端再校验） */
  function addAppKey(aud) {
    if (!window.PublicKeyCredential) {
      toast(t('pkNoSupport'));
      return;
    }
    api('/api/owner-passkey', { action: 'challenge', type: 'register', pkClass: 'app', aud: aud })
      .then(function (res) {
        const ch = res.json;
        if (!ch || !ch.ok) throw new Error((ch && ch.error) || 'challenge');
        return navigator.credentials.create({
          publicKey: {
            challenge: b64urlToBuf(ch.challenge),
            rp: { id: ch.rpId, name: ch.rp.name },
            user: {
              id: b64urlToBuf(ch.user.id),
              name: ch.user.name,
              displayName: ch.user.displayName,
            },
            pubKeyCredParams: [{ alg: -7, type: 'public-key' }, { alg: -257, type: 'public-key' }],
            authenticatorSelection: { userVerification: 'required', residentKey: 'preferred' },
            excludeCredentials: (ch.excludeCredentials || []).map(function (c) {
              return { id: b64urlToBuf(c.id), type: c.type };
            }),
            timeout: 60000,
          },
        }).then(function (cred) {
          return { cred: cred, cid: ch.cid };
        });
      })
      .then(function (r2) {
        const cred = r2.cred;
        return api('/api/owner-passkey', {
          action: 'register',
          cid: r2.cid,
          credential: {
            id: cred.id,
            rawId: bufToB64url(cred.rawId),
            type: cred.type,
            response: {
              clientDataJSON: bufToB64url(cred.response.clientDataJSON),
              attestationObject: bufToB64url(cred.response.attestationObject),
            },
          },
        });
      })
      .then(function (res) {
        if (res.json && res.json.ok) {
          toast(t('pkRegistered') || '已添加');
          refreshPkList();
        } else {
          toast(t('gateSrvErr') || '失败');
        }
      })
      .catch(function () {
        toast(t('gateNetErr') || '网络错误');
      });
  }

  /* 添加通行密钥 */
  const pkAdd = $('lockmgr-pkadd');
  if (pkAdd) {
    on(pkAdd, 'click', function () {
      if (!window.PublicKeyCredential) {
        toast(t('pkNoSupport'));
        return;
      }
      /* 2.10.0：无 token 检查；api() 在 stepup-required 时自动验证后重试 */
      api('/api/owner-passkey', { action: 'challenge', type: 'register', pkClass: 'lock' })
        .then(function (res) {
          const ch = res.json;
          if (!ch) throw { kind: 'server' };
          if (!ch.ok) {
            if (ch.error === 'stepup-required') throw { kind: 'reauth' };
            throw { kind: 'server' };
          }
          /* 服务端下发 rp.id、用户信息、excludeCredentials；前端不硬编码、不回落 */
          const rpId = ch.rpId;
          const user = ch.user || {};
          const rp = ch.rp || {};
          const exclude = (ch.excludeCredentials || []).map(function (c) {
            return { id: b64urlToBuf(c.id), type: c.type };
          });
          return navigator.credentials
            .create({
              publicKey: {
                challenge: b64urlToBuf(ch.challenge),
                rp: { name: rp.name || 'Styrigx', id: rpId },
                user: {
                  id: b64urlToBuf(user.id),
                  name: user.name || 'owner',
                  displayName: user.displayName || 'Sloan Gray',
                },
                pubKeyCredParams: [{ type: 'public-key', alg: -7 }],
                authenticatorSelection: { userVerification: 'required', residentKey: 'required' },
                excludeCredentials: exclude,
                attestation: 'none',
                timeout: 60000,
              },
            })
            .then(function (cred) {
              return { cred: cred, cid: ch.cid };
            }, function (e) {
              if (e && e.name === 'NotAllowedError') throw { kind: 'cancelled' };
              if (e && e.name === 'InvalidStateError') throw { kind: 'already' };
              if (e && e.name === 'NotSupportedError') throw { kind: 'nosupport' };
              throw { kind: 'failed' };
            });
        })
        .then(function (r2) {
          const cred = r2.cred;
          /* 注册时直接带预填名（服务端已支持 body.name） */
          const prefill = genPkPrefillName();
          return api('/api/owner-passkey', {
            action: 'register',
            token: token,
            cid: r2.cid,
            name: prefill,
            credential: {
              id: cred.id,
              rawId: bufToB64url(cred.rawId),
              response: {
                clientDataJSON: bufToB64url(cred.response.clientDataJSON),
                attestationObject: bufToB64url(cred.response.attestationObject),
              },
              type: cred.type,
            },
          }).then(function (res) {
            return { res: res, prefill: prefill };
          });
        })
        .then(function (r3) {
          const j = r3.res.json;
          if (j && j.ok) {
            /* 注册成功 → 弹出命名弹层（预填名已提交，用户改名才调 rename） */
            openPkNameDlg(j.credId, r3.prefill);
            refreshPkList();
            /* 新注册后刷新门禁状态（通行密钥选项） */
            fetch('/api/owner-status', { method: 'GET', credentials: 'same-origin' }).catch(function () {});
          } else if (j && j.error === 'stepup-required') {
            needReauth();
          } else {
            toast(t('gateSrvErr'));
          }
        })
        .catch(function (e) {
          if (!e) return;
          if (e.kind === 'cancelled') toast(t('gateCancelled'));
          else if (e.kind === 'already') toast(t('pkAlready'));
          else if (e.kind === 'nosupport') toast(t('pkNoSupport'));
          else if (e.kind === 'reauth') needReauth();
          else if (e.kind === 'server') toast(t('gateSrvErr'));
          else if (e.kind === 'failed') toast(t('pkFailed'));
          else toast(t('gateNetErr'));
        });
    });
  }

  /* 进入即弹验证身份 */
  openGate();
})();
