/**
 * @fileoverview 「分享本页」（共享外壳组件，2026-10-24；gen-shell 原样复制成 space/web/shared/shell/share.js，三个子站 sync-shell 同步）。
 *
 * 2026-11-04 P5-1 起它是快捷面板的「分享本页」磁贴 [data-qp="share"][data-sgx-share]（顶栏右圆分享删除）；
 * P4-3 PR-4b（Gray 2026-11-07）起四站快捷面板同一套，主站也有这块磁贴（shell/quick-panel.js 传 mountShare）。
 * 点分享（进门二值，P2-3：不分角色，所有进门的人都一样）：
 * - POST https://styrigx.com/api/share（credentials: include）
 *   { action:'create', reuse:true, name: 页面标题（截 24 字）, to: 当前页（origin + pathname + search，去掉 entry / lock / why / return / share），
 *     hours: 24, session: 43200 } → 带临时会话的短链（链接 24 小时、点开能看 12 小时）。
 *   服务端复用：同一页、同样档位、还剩 ≥ 12 小时的有效短链直接返回，不签新钥匙。
 *   拿到 https://styrigx.com/s/<码> → navigator.share({ title, url })；没有 Web Share 或被拒（不是用户取消 AbortError）→ 复制 + toast「已复制分享链接」。
 *   生成中：按钮 aria-busy + .is-busy（图标呼吸），再点不理。生成失败：toast 说原因；绝不把不带会话的原地址当成短链分享出去。
 * - 新建分享链接只要进站会话，不验证（进站 v3 Q3 定稿，Gray 2026-11-09 08:00：临时钥匙、分享链接进来的人也能发）；
 *   原来的最小复验弹层（lockReauthStep / .sgx-share-reauth）删了。401 只剩「会话过期，回锁屏再进」。
 *   列表 / 作废在盾牌「分享链接」层（要 reauth）。
 *
 * 自成一体：不 import 任何东西；toast 自己建（.sgx-share-toast，样式在 shell.css topbar-frame 段，只用 --sgx-* 角色）。
 * 用法：import { mountShare } from '…/share.js'; mountShare();  // 每页一次；找不到 [data-sgx-share] 就什么也不做
 */

/** 生成短链的接口（站点核心 Worker styrigx-space-core 的 /api/share；CORS 只认三个子站） */
export const SHARE_API = 'https://styrigx.com/api/share';
export const SHARE_ORIGIN = 'https://styrigx.com';
/** 一键分享的档位：链接 24 小时、点开后能看 12 小时（和设置 → 临时钥匙页「新建分享短链」的默认一样） */
export const QUICK = Object.freeze({ hours: 24, session: 12 * 3600 });
/** 分享地址里去掉的查询参数（同服务端 STRIP_PARAMS） */
export const STRIP_PARAMS = Object.freeze(['entry', 'lock', 'why', 'return', 'share']);
export const NAME_MAX = 24;

/** 英文底（源文本，没有页面字符串表时用）；页面上以 #sgx-i18n-shell 的 share 节为准——已是「英文 ← 页面语言」的合并，缺键回退英文（语言包化 2026-11-07） */
const STR_EN = {
  share: "Share",
  copied: "Share link copied",
  copyFail: "Couldn’t copy. Please try again",
  busy: "Creating share link…",
  session: "Your session has expired. Unlock again to share",
  full: "You already have 20 share links. Revoke some on styrigx.com first",
  forbidden: "Only root can create share links · run su root first",
  fail: "Couldn’t create a share link. Please try again"
};
/** @param {Document} doc @returns {Record<string, string>} */
function shellStr(doc) {
  /** @type {Record<string, string>} */
  let page = {};
  try {
    const el = doc && doc.getElementById ? doc.getElementById('sgx-i18n-shell') : null;
    const o = el && el.textContent ? JSON.parse(el.textContent) : null;
    if (o && o.share && typeof o.share === 'object') page = o.share;
  } catch (e) {}
  return Object.assign({}, STR_EN, page);
}

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

/** 接口错误 → 文案键（新建不要 reauth：401 一律是会话过期） @param {number} status @param {any} j */
export function errKey(status, j) {
  const e = j && j.error;
  if (status === 401 || e === 'session') return 'session';
  /* 2b：v6 身份不是 root（/api/share 是 root 档，网关 403 forbidden）：不是会话过期 */
  if (status === 403 && e === 'forbidden') return 'forbidden';
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
  const t = shellStr(doc);
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
      const r = await createLink({ url, title, fetch: c.fetch, api: c.api });
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
