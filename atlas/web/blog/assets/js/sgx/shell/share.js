/* @sgx-shell:begin styrigx/styrigx-space@tree:93c2a5d62c5d space/web/shared/shell vb0440bfedc2e（space/scripts/blog/sync-shell.mjs 写入，勿手改） */
/* ---- share.js ---- */
/**
 * @fileoverview 「分享本页」（共享外壳组件，2026-10-24；gen-shell 原样复制成 space/web/shared/shell/share.js，三个子站 sync-shell 同步）。
 *
 * 2026-11-04 P5-1 起它是快捷面板的「分享本页」磁贴 [data-qp="share"][data-sgx-share]（顶栏右圆分享删除）；
 * P4-3 PR-4b（Gray 2026-11-07）起四站快捷面板同一套，主站也有这块磁贴（shell/quick-panel.js 传 mountShare）。
 * 点分享（进门二值，P2-3：不分角色，所有进门的人都一样）：
 * - POST https://styrigx.com/api/share（credentials: include）
 *   { action:'create', reuse:true, name: 页面标题（截 24 字）, to: 当前页（origin + pathname + search，去掉 lock / why / return / share），
 *     hours: 24, session: 43200 } → 带临时会话的短链（链接 24 小时、点开能看 12 小时）。
 *   服务端复用：同一页、同样档位、还剩 ≥ 12 小时的有效短链直接返回，不签新钥匙。
 *   拿到 https://styrigx.com/s/<码> → navigator.share({ title, url })；没有 Web Share 或被拒（不是用户取消 AbortError）→ 复制 + toast「已复制分享链接」。
 *   生成中：按钮 aria-busy + .is-busy（图标呼吸），再点不理。生成失败：toast 说原因；绝不把不带会话的原地址当成短链分享出去。
 * - 生成 / 复用短链等于发一张入门凭证，要锁侧复验（定案第 7 条）：服务端回 401 reauth → 弹本文件里的最小复验步骤
 *   lockReauthStep()（只有锁屏通行密钥 / 解锁密码两种方式，设了哪个显示哪个；主站的完整复验层在 auth/lock-reauth.js，子站没有）。
 *   通过（拿到 3 分钟 sgx-lock-reauth）→ 自动重试一次；取消 → 什么也不分享。临时钥匙 / 短链进门的会话本身不算复验。
 *
 * 自成一体：不 import 任何东西；toast、复验步骤都自己建（.sgx-share-toast / .sgx-share-reauth，样式在 shell.css topbar-frame 段，只用 --sgx-* 角色）。
 * 用法：import { mountShare } from '…/share.js'; mountShare();  // 每页一次；找不到 [data-sgx-share] 就什么也不做
 */

/** 生成短链的接口（分享短链 Worker styrigx-share；CORS 只认三个子站） */
export const SHARE_API = 'https://styrigx.com/api/share';
export const SHARE_ORIGIN = 'https://styrigx.com';
/** 一键分享的档位：链接 24 小时、点开后能看 12 小时（和设置 → 临时钥匙页「新建分享短链」的默认一样） */
export const QUICK = Object.freeze({ hours: 24, session: 12 * 3600 });
/** 分享地址里去掉的查询参数（同服务端 STRIP_PARAMS） */
export const STRIP_PARAMS = Object.freeze(['lock', 'why', 'return', 'share']);
export const NAME_MAX = 24;

const STR = {
  zh: {
    share: '分享',
    copied: '已复制分享链接',
    copyFail: '复制失败，请稍后再试',
    busy: '正在生成分享链接…',
    session: '锁屏会话已失效，请重新解锁后再分享',
    full: '分享短链已满 20 条，先去主站作废几条',
    fail: '生成分享链接失败，请稍后再试',
    rTitle: '验证锁屏凭证',
    rDesc: '生成分享链接前，先验证一次锁屏凭证',
    rPasskey: '锁屏通行密钥',
    rPassword: '解锁密码',
    rVerify: '验证',
    rCancel: '取消',
    rWrong: '密码错误',
    rLocked: '尝试次数过多，请稍后再试',
    rFail: '验证失败',
    rNone: '这台设备上没有可用的锁屏凭证',
  },
  en: {
    share: 'Share',
    copied: 'Share link copied',
    copyFail: 'Couldn’t copy. Please try again',
    busy: 'Creating share link…',
    session: 'Your session has expired. Unlock again to share',
    full: 'You already have 20 share links. Revoke some on styrigx.com first',
    fail: 'Couldn’t create a share link. Please try again',
    rTitle: 'Verify lock screen credential',
    rDesc: 'Verify your lock screen credential before creating a share link',
    rPasskey: 'Lock screen passkey',
    rPassword: 'Unlock password',
    rVerify: 'Verify',
    rCancel: 'Cancel',
    rWrong: 'Wrong password',
    rLocked: 'Too many attempts, please try again later',
    rFail: 'Verification failed',
    rNone: 'No lock screen credential is available here',
  },
};

/** 当前页 → 要分享的地址：origin + pathname + search（不带 #），去掉锁屏 / 回跳 / 分享参数 @param {{origin:string, pathname:string, search:string}} loc */
export function pageUrl(loc) {
  const sp = new URLSearchParams(loc.search || '');
  for (const k of STRIP_PARAMS) sp.delete(k);
  const q = sp.toString();
  return loc.origin + loc.pathname + (q ? '?' + q : '');
}

/** 页面标题 → 短链名字（去控制字符、首尾空格，最多 24 字） @param {string} t */
export function linkName(t) {
  const v = String(t || '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  return Array.from(v).slice(0, NAME_MAX).join('');
}

/** 接口错误 → 文案键（401 reauth = 要锁侧复验，单独处理） @param {number} status @param {any} j */
export function errKey(status, j) {
  const e = j && j.error;
  if (status === 401 && e === 'reauth') return 'reauth';
  if (status === 401 || e === 'session') return 'session';
  if (status === 409 || e === 'full') return 'full';
  return 'fail';
}

/**
 * 请服务端生成（或复用）带临时会话的短链。
 * @param {{ url: string, title: string, fetch?: typeof fetch, api?: string }} p
 * @returns {Promise<{ok:true, url:string, reused:boolean}|{ok:false, key:string}>}
 */
export async function createLink(p) {
  const f = p.fetch || fetch;
  let res;
  try {
    res = await f(p.api || SHARE_API, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'create', reuse: true, name: linkName(p.title), to: p.url, hours: QUICK.hours, session: QUICK.session }),
    });
  } catch (e) {
    return { ok: false, key: 'fail' };
  }
  let j = null;
  try { j = await res.json(); } catch (e) {}
  const path = j && j.ok === true && j.link && typeof j.link.path === 'string' ? j.link.path : '';
  if (!res.ok || !/^\/s\/[A-Za-z0-9_-]{22}$/.test(path)) return { ok: false, key: errKey(res.status, j) };
  return { ok: true, url: SHARE_ORIGIN + path, reused: !!j.reused };
}

/* ---------------- 最小锁侧复验步骤（P2-3；方案第 8 节 N-2） ---------------- */

/** base64url → ArrayBuffer @param {string} s */
function b64uToBuf(s) {
  const b = atob(String(s).replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((String(s).length + 3) % 4));
  const u = new Uint8Array(b.length);
  for (let i = 0; i < b.length; i++) u[i] = b.charCodeAt(i);
  return u.buffer;
}
/** ArrayBuffer → base64url @param {ArrayBuffer} buf */
function bufToB64u(buf) {
  const u = new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < u.length; i++) s += String.fromCharCode(u[i]);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * 锁侧复验的两条路（同锁屏凭证页门口，只是少了进站凭证）。都只发同源 POST，带 cookie；成功时服务端种 sgx-lock-reauth（3 分钟）。
 * @param {{ fetch?: typeof fetch, origin?: string, nav?: any }} [o]
 */
export function reauthApi(o) {
  const f = (o && o.fetch) || fetch;
  const origin = (o && o.origin) || SHARE_ORIGIN;
  /** @param {string} p @param {any} body */
  const post = async function (p, body) {
    let res;
    try {
      res = await f(origin + p, { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    } catch (e) {
      return { s: 0, j: null };
    }
    let j = null;
    try { j = await res.json(); } catch (e) {}
    return { s: res.status, j };
  };
  return {
    /** 设了哪些锁屏凭证：{ok, passkey, password}（/api/lock-reauth status，进门即可） */
    status: () => post('/api/lock-reauth', { action: 'status' }),
    /** @param {string} pw */
    password: async (pw) => {
      const r = await post('/api/lock-password', { action: 'verify', password: pw, reauth: true });
      if (r.j && r.j.ok) return 'ok';
      if (r.s === 429 || (r.j && r.j.error === 'cooldown')) return 'locked';
      if (r.j && r.j.error === 'wrong') return 'wrong';
      return 'fail';
    },
    passkey: async () => {
      const nav = (o && o.nav) || (typeof navigator !== 'undefined' ? navigator : null);
      if (!nav || !nav.credentials || typeof nav.credentials.get !== 'function') return 'fail';
      const ch = await post('/api/lock-passkey', { action: 'challenge', type: 'auth' });
      if (!ch.j || !ch.j.ok || !ch.j.challenge) return 'fail';
      /** @type {any} */
      const pk = { challenge: b64uToBuf(ch.j.challenge), userVerification: 'required', timeout: 30000 };
      if (ch.j.rpId) pk.rpId = ch.j.rpId;
      if (Array.isArray(ch.j.allowCredentials) && ch.j.allowCredentials.length) {
        pk.allowCredentials = ch.j.allowCredentials.map((c) => ({ id: b64uToBuf(c.id), type: c.type || 'public-key' }));
      }
      /** @type {any} */
      let cred = null;
      try {
        cred = await nav.credentials.get({ publicKey: pk });
      } catch (e) {
        return 'cancelled';
      }
      if (!cred) return 'cancelled';
      const r = await post('/api/lock-passkey', {
        action: 'auth', reauth: true, cid: ch.j.cid,
        credential: {
          id: cred.id, rawId: bufToB64u(cred.rawId), type: cred.type,
          response: {
            authenticatorData: bufToB64u(cred.response.authenticatorData),
            clientDataJSON: bufToB64u(cred.response.clientDataJSON),
            signature: bufToB64u(cred.response.signature),
            userHandle: cred.response.userHandle ? bufToB64u(cred.response.userHandle) : null,
          },
        },
      });
      return r.j && r.j.ok ? 'ok' : 'fail';
    },
  };
}

/**
 * 最小复验步骤：一个 <dialog class="sgx-share-reauth">（标题 + 一行说明 + 锁屏通行密钥按钮 / 解锁密码输入 + 取消），通过 resolve(true)。
 * 取消 / Esc / 关掉 resolve(false)。设了哪个锁屏凭证显示哪个（status 读不到就两个都给）。
 * @param {{ doc?: Document, t: Record<string,string>, api: ReturnType<typeof reauthApi> }} o
 * @returns {Promise<boolean>}
 */
export async function lockReauthStep(o) {
  const doc = o.doc || document;
  const t = o.t;
  const st = await o.api.status();
  if (st.s === 401) return false;
  const has = st.j && st.j.ok ? { passkey: !!st.j.passkey, password: !!st.j.password } : { passkey: true, password: true };
  return new Promise(function (resolve) {
    const d = /** @type {HTMLDialogElement} */ (doc.createElement('dialog'));
    d.className = 'sgx-share-reauth';
    d.setAttribute('aria-labelledby', 'sgx-share-reauth-t');
    const pw = has.password
      ? '<form class="sgx-share-reauth-pw" method="dialog"><input type="text" name="username" value="LockKey" autocomplete="username" hidden>' +
        '<input type="password" class="sgx-share-reauth-in" autocomplete="current-password" aria-label="' + t.rPassword + '" placeholder="' + t.rPassword + '">' +
        '<button type="submit" class="sgx-share-reauth-btn">' + t.rVerify + '</button></form>'
      : '';
    d.innerHTML =
      '<h2 id="sgx-share-reauth-t" class="sgx-share-reauth-title">' + t.rTitle + '</h2>' +
      '<p class="sgx-share-reauth-desc">' + (has.passkey || has.password ? t.rDesc : t.rNone) + '</p>' +
      (has.passkey ? '<button type="button" class="sgx-share-reauth-btn" data-pk>' + t.rPasskey + '</button>' : '') + pw +
      '<p class="sgx-share-reauth-err" role="alert" hidden></p>' +
      '<button type="button" class="sgx-share-reauth-cancel" data-cancel>' + t.rCancel + '</button>';
    doc.body.appendChild(d);
    const err = /** @type {HTMLElement} */ (d.querySelector('.sgx-share-reauth-err'));
    let busy = false;
    let settled = false;
    /** @param {boolean} v */
    const finish = function (v) {
      if (settled) return;
      settled = true;
      try { if (d.open) d.close(); } catch (e) {}
      d.remove();
      resolve(v);
    };
    /** @param {string} r */
    const after = function (r) {
      busy = false;
      d.removeAttribute('aria-busy');
      if (r === 'ok') return finish(true);
      if (r === 'cancelled') return;
      err.textContent = r === 'wrong' ? t.rWrong : r === 'locked' ? t.rLocked : t.rFail;
      err.hidden = false;
    };
    const pkBtn = d.querySelector('[data-pk]');
    if (pkBtn) pkBtn.addEventListener('click', async function () {
      if (busy) return;
      busy = true;
      err.hidden = true;
      d.setAttribute('aria-busy', 'true');
      after(await o.api.passkey());
    });
    const form = d.querySelector('form');
    if (form) form.addEventListener('submit', async function (e) {
      e.preventDefault();
      const inp = /** @type {HTMLInputElement} */ (form.querySelector('.sgx-share-reauth-in'));
      if (busy || !inp.value) return;
      busy = true;
      err.hidden = true;
      d.setAttribute('aria-busy', 'true');
      const r = await o.api.password(inp.value);
      if (r === 'wrong') inp.value = '';
      after(r);
    });
    const cancel = d.querySelector('[data-cancel]');
    if (cancel) cancel.addEventListener('click', function () { finish(false); });
    d.addEventListener('cancel', function (e) { e.preventDefault(); finish(false); });
    try { d.showModal(); } catch (e) { finish(false); }
  });
}

/** @param {string} text @param {Navigator} nav @param {Document} doc */
async function copyText(text, nav, doc) {
  try {
    if (nav.clipboard && typeof nav.clipboard.writeText === 'function') {
      await nav.clipboard.writeText(text);
      return true;
    }
  } catch (e) {}
  try {
    const ta = doc.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0;pointer-events:none';
    doc.body.appendChild(ta);
    ta.select();
    const ok = doc.execCommand('copy');
    ta.remove();
    return !!ok;
  } catch (e) {
    return false;
  }
}

/**
 * 系统分享；没有 / 被拒（不是用户取消）就复制。
 * @param {{title:string, url:string}} data
 * @param {{ nav?: Navigator, doc?: Document, toast: (m:string)=>void, t: Record<string,string> }} o
 * @returns {Promise<'shared'|'aborted'|'copied'|'failed'>}
 */
export async function shareOrCopy(data, o) {
  const nav = o.nav || navigator;
  const doc = o.doc || document;
  if (typeof nav.share === 'function') {
    try {
      await nav.share({ title: data.title, url: data.url });
      return 'shared';
    } catch (e) {
      if (e && /** @type {any} */ (e).name === 'AbortError') return 'aborted';
    }
  }
  if (await copyText(data.url, nav, doc)) {
    o.toast(o.t.copied);
    return 'copied';
  }
  o.toast(o.t.copyFail);
  return 'failed';
}

/** @param {Document} doc */
function makeToast(doc) {
  /** @type {HTMLElement|null} */
  let el = null;
  /** @type {any} */
  let timer = null;
  return function (/** @type {string} */ msg) {
    if (!msg) return;
    if (!el) {
      el = doc.createElement('div');
      el.className = 'sgx-share-toast';
      el.setAttribute('role', 'status');
      el.setAttribute('aria-live', 'polite');
      doc.body.appendChild(el);
    }
    el.textContent = msg;
    void el.offsetWidth;
    el.classList.add('show');
    clearTimeout(timer);
    timer = setTimeout(function () { if (el) el.classList.remove('show'); }, 2400);
  };
}

/**
 * @typedef {Object} ShareConfig
 * @property {Element|null} [button] 分享按钮（默认 [data-sgx-share]）
 * @property {'zh'|'en'} [lang] 默认按 <html lang>
 * @property {(m:string)=>void} [toast] 自己的 toast（默认外壳的 .sgx-share-toast）
 * @property {() => string} [url] 要分享的地址（默认 pageUrl(location)）
 * @property {() => string} [title] 标题（默认 document.title）
 * @property {typeof fetch} [fetch]
 * @property {string} [api]
 * @property {() => Promise<boolean>} [reauth] 锁侧复验（默认 lockReauthStep；测试替换）
 * @property {Document} [doc]
 * @property {Navigator} [nav]
 */

/**
 * 绑定分享按钮。返回 { share() }（测试 / 键盘快捷键用；和点按钮一样）；没有按钮返回 null。
 * @param {ShareConfig} [cfg]
 */
export function mountShare(cfg) {
  const c = cfg || {};
  const doc = c.doc || document;
  const btn = c.button || doc.querySelector('[data-sgx-share]');
  if (!btn || /** @type {any} */ (btn).__sgxShare) return null;
  const lang = c.lang || (/^en/i.test(doc.documentElement.lang || '') ? 'en' : 'zh');
  const t = STR[lang] || STR.zh;
  const toast = c.toast || makeToast(doc);
  let busy = false;

  function setBusy(/** @type {boolean} */ v) {
    busy = v;
    btn.classList.toggle('is-busy', v);
    if (v) btn.setAttribute('aria-busy', 'true');
    else btn.removeAttribute('aria-busy');
  }

  async function share() {
    if (busy) return 'busy';
    const url = c.url ? c.url() : pageUrl(location);
    const title = c.title ? c.title() : doc.title;
    setBusy(true);
    try {
      let r = await createLink({ url, title, fetch: c.fetch, api: c.api });
      if (!r.ok && r.key === 'reauth') {
        const ok = c.reauth ? await c.reauth() : await lockReauthStep({ doc, t, api: reauthApi({ fetch: c.fetch, nav: c.nav }) });
        if (!ok) return 'cancelled';
        r = await createLink({ url, title, fetch: c.fetch, api: c.api });
      }
      if (!r.ok) {
        toast(t[r.key] || t.fail);
        return 'error';
      }
      return await shareOrCopy({ title, url: r.url }, { nav: c.nav, doc, toast, t });
    } finally {
      setBusy(false);
    }
  }

  /** @type {any} */ (btn).__sgxShare = true;
  btn.addEventListener('click', function (e) {
    e.preventDefault();
    share();
  });
  return { share };
}
/* @sgx-shell:end */
