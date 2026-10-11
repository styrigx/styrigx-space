/**
 * @fileoverview 锁定屏幕管理页（2.4.0 安全与隐私，替代 /owner/）。
 * - 进入前底部弹层「验证身份」：使用通行密钥 / 使用管理密钥（无通行密钥时只显示管理密钥）；
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

  /** 管理 token（验证后签发，只存内存） */
  let token = null;
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
  /** @param {string} url @param {any} body */
  function api(url, body) {
    return fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }).then(parseApi);
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

  /* 使用管理密钥 → 显示输入框 */
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
    api('/api/owner-auth', { key: k })
      .then(function (res) {
        const j = res.json;
        if (!j) {
          showErr('lockgate-err', t('gateSrvErr'));
          return;
        }
        if (j.ok && j.token) {
          token = j.token;
          enterMgr();
        } else {
          showErr('lockgate-err', t('gateKeyWrong'));
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

  /* 使用通行密钥 → WebAuthn 验证，通过后服务端签发管理 token */
  if (gatePkBtn) {
    on(gatePkBtn, 'click', function () {
      hideErr('lockgate-err');
      if (!window.PublicKeyCredential) {
        showErr('lockgate-err', t('pkNoSupport'));
        return;
      }
      api('/api/owner-passkey', { action: 'challenge', type: 'auth' })
        .then(function (res) {
          const ch = res.json;
          if (!ch) throw { kind: 'server' };
          if (!ch.ok) throw { kind: 'server' };
          const allow = (ch.allowCredentials || []).map(function (c) {
            return { id: b64urlToBuf(c.id), type: c.type };
          });
          return navigator.credentials
            .get({ publicKey: { challenge: b64urlToBuf(ch.challenge), allowCredentials: allow, userVerification: 'required', timeout: 60000 } })
            .then(function (cred) {
              return { cred: cred, cid: ch.cid };
            }, function (e) {
              throw { kind: e && e.name === 'NotAllowedError' ? 'cancelled' : 'failed' };
            });
        })
        .then(function (r2) {
          const cred = r2.cred;
          return api('/api/owner-passkey', {
            action: 'auth',
            cid: r2.cid,
            credential: {
              id: cred.id,
              rawId: bufToB64url(cred.rawId),
              response: {
                clientDataJSON: bufToB64url(cred.response.clientDataJSON),
                authenticatorData: bufToB64url(cred.response.authenticatorData),
                signature: bufToB64url(cred.response.signature),
                userHandle: cred.response.userHandle ? bufToB64url(cred.response.userHandle) : null,
              },
              type: cred.type,
            },
          });
        })
        .then(function (res) {
          const j = res.json;
          if (j && j.ok && j.token) {
            token = j.token;
            /* 迁移旧密钥：更新密码管理器里的用户姓名（特性检测，不支持就跳过） */
            try {
              if (window.PublicKeyCredential &&
                  typeof PublicKeyCredential.signalCurrentUserDetails === 'function') {
                PublicKeyCredential.signalCurrentUserDetails({
                  rpId: location.hostname,
                  userId: cred.rawId,
                  name: 'owner',
                  displayName: 'Sloan Gray',
                }).catch(function () {});
              }
            } catch (e) {}
            enterMgr();
          } else if (!j) {
            showErr('lockgate-err', t('gateSrvErr'));
          } else {
            showErr('lockgate-err', t('gatePkErr'));
          }
        })
        .catch(function (e) {
          if (e && e.kind === 'cancelled') toast(t('gateCancelled'));
          else if (e && e.kind === 'failed') showErr('lockgate-err', t('gatePkErr'));
          else if (e && e.kind === 'server') showErr('lockgate-err', t('gateSrvErr'));
          else showErr('lockgate-err', t('gateNetErr'));
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
      if (!token) {
        needReauth();
        return;
      }
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
      if (!token) {
        needReauth();
        return;
      }
      if (!armed) {
        armed = true;
        /* 如果删完后密码和通行密钥都没了，提示只能用管理密钥进入 */
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
      api('/api/owner-password', { action: 'remove', token: token })
        .then(function (r) {
          const j = r.json;
          if (j && j.ok) {
            toast(t('pwDeleted'));
            /* 服务端删除成功后重新读状态刷新（KV 最终一致，边缘节点最多约 60 秒） */
            refreshStatus();
            refreshPkList();
          } else if (j && j.error === 'token') {
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
          } else if (j && (j.error === 'token' || r.status === 401)) {
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
      ? { action: 'set', token: token, password: va }
      : { action: 'change', token: token, newPassword: va };
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
        } else if (j.error === 'token') {
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
      api('/api/owner-passkey', { action: 'rename', token: token, credId: pkNameCredId, name: name })
        .then(function (r) {
          const j = r.json;
          if (j && j.ok) {
            toast(t('pkRegistered'));
            closePkNameDlg();
            refreshPkList();
          } else if (j && j.error === 'token') {
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

  /* 通行密钥列表 */
  function refreshPkList() {
    if (!token) return;
    const ul = $('lockmgr-pklist');
    const empty = $('lockmgr-pkempty');
    api('/api/owner-passkey', { action: 'list', token: token })
      .then(function (res) {
        const j = res.json;
        if (!j) return;
        if (j.error === 'token') {
          needReauth();
          return;
        }
        const keys = (j.ok && j.keys) || [];
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
            api('/api/owner-passkey', { action: 'rename', token: token, credId: k.credId, name: v })
              .then(function (r2) {
                const jj = r2.json;
                if (jj && jj.ok) {
                  lastSaved = v;
                  toast(t('pkRenamed'));
                } else if (jj && jj.error === 'token') {
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
            api('/api/owner-passkey', { action: 'delete', token: token, credId: k.credId })
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
                } else if (jj && jj.error === 'token') {
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

  /* 添加通行密钥 */
  const pkAdd = $('lockmgr-pkadd');
  if (pkAdd) {
    on(pkAdd, 'click', function () {
      if (!window.PublicKeyCredential) {
        toast(t('pkNoSupport'));
        return;
      }
      if (!token) {
        needReauth();
        return;
      }
      api('/api/owner-passkey', { action: 'challenge', type: 'register', token: token })
        .then(function (res) {
          const ch = res.json;
          if (!ch) throw { kind: 'server' };
          if (!ch.ok) {
            if (ch.error === 'token') throw { kind: 'reauth' };
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
          } else if (j && j.error === 'token') {
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
