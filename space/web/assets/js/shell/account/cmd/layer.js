/**
 * @fileoverview 全站终端里的账号层（v5 S5 终端合一；S9 起账号的所有操作都在这里，账号卡片 shell/account/window.js 只展示）。
 *
 * 终端里的账号命令（shell/term/cmds/acct、keys/sudo.js 的 sudo root …、sub）调这里挂在 C 上的流程：sudo root（../session.js）、sudo root reauth（../reauth.js）、
 * sudo root reset（../reset.js，reset@account:~#）、passwd / passkey（./keys.js）、device（./devices.js）、app（./grants.js）、profile（./profile.js）、sub（../proxy.js）、exit。
 * 页面上的入口（[data-acct-open]、旧地址 #acct=…，topbar-panel.js 接）也在这里跑：entry({ reset | reauth | app })——
 * sudo root reset、只做再验证（奇趣导入书签：验过发 sgx-account-reauthed，等页面做完再结束 reauth）、奇趣 / 日刻的授权同意。
 * 要输入、选择、验证的都在终端里原地做完；输出 / 输入模式走终端的输入行（shell/term/view/layer-ctx.js）。后端只在 ../api.js。
 *
 * 只 import lib/、auth/、shell/（check-layers 规则 3）。文案在外壳字符串表 account.*（sgx-shell-i18n），四个站同一份。
 */
import { esc } from '../../../lib/util.js';
import { toast } from '../../../lib/toast.js';
import { readCache, effectiveProfile, profileDefaults } from '../../../lib/profile.js';
import { flatStrings } from '../../term/core/strings.js';
import { layerCtx } from '../../term/view/layer-ctx.js';
import * as api from '../api.js';
import { CMD } from '../commands.js';
import { mountSession } from '../session.js';
import { mountReauth } from '../reauth.js';
import { mountReset } from '../reset.js';
import { mountProxy } from '../proxy.js';
import { correctSignedInMarker, firstFrameState } from '../window.js';
import { mountKeys } from './keys.js';
import { mountDevices } from './devices.js';
import { mountGrants } from './grants.js';
import { mountProfile } from './profile.js';

/** 只做再验证时，等页面把要复验的事做完的上限（毫秒）；到点不管做没做完都结束 reauth */
export const REAUTH_HOLD_MS = 60000;

/**
 * @typedef {Object} TermLink 终端那一头（topbar-panel.js 给）
 * @property {(after?: () => void) => void} close 收起终端窗口
 * @property {() => boolean} shown 终端窗口开着
 */

/**
 * @param {{
 *   S: any,
 *   line: any,
 *   who: { setAccount: (on: boolean) => void, drop: () => void },
 *   term: TermLink,
 *   replace: (href: string) => void,
 *   reload?: () => void,
 * }} o S = 外壳字符串表的 account 节（嵌套）；line = 终端输入行（input-line 的 C）
 */
export function mountAccountLayer(o) {
  const doc = document;
  const S = flatStrings(o.S || {});
  /** @param {string} k */
  const t = function (k) { return S[k] || ''; };
  /** @param {string} k @param {Record<string, string|number>} v */
  const tf = function (k, v) { let s = t(k); for (const n in v) s = s.split('{' + n + '}').join(String(v[n])); return s; };
  /** auth/post-json.js errText 用的是旧的平铺键名：这里接到新表上 @param {string} k */
  const errT = function (k) { return k === 'reauthExpired' ? t('reauth.expired') : k === 'devCurrent' ? t('devices.currentHint') : t('common.' + k); };
  const reload = o.reload || function () { try { location.reload(); } catch (e) {} };
  /* sub upload 的文件选择框挂在这个不上页面的节点上 */
  const root = doc.createElement('div');

  /**
   * 账号层上下文：状态 + 流程；功能模块读写它，并把自己的函数挂上来。输出 / 输入模式来自终端输入行（原型）。
   * @type {any}
   */
  const C = layerCtx(o.line, {
    doc: doc, root: root, term: o.term,
    t: t, tf: tf, errT: errT, esc: esc, api: api, toast: toast, reload: reload,
    /** '' 未知 · in · guest */ st: '',
    /** api.status() 的结果 */ status: null,
    /** reauth / reset 票到期（毫秒；0 = 没有） */ reauthExp: 0, resetExp: 0,
    /** reset 票下已改过凭证，还没选登出方式 */ resetPending: false,
    /** 当前在 sudo root reset 里 */ inReset: false,
    /** 奇趣 / 日刻要授权：{ app }（页面入口 entry 给） */ consent: null,
    tries: 0,
    /** 登录状态变了：收起终端时重新载入 */ loginChanged: false,
  });
  /** 注释行 `# …`（这里传文案键；{x} 换成黄色命令） @param {string} key @param {string} [x] */
  C.note = function (key, x) { C.out('# ' + esc(t(key)).replace('{x}', x ? C.k(x) : ''), 'd'); };
  /** 服务端错误码 → 红字 @param {{s: number, j: any}} res */
  C.apiErr = function (res) { C.err(api.errText(errT, res && res.j && res.j.error, res && res.s)); };
  C.netErr = function () { C.err(t('common.errNetwork')); };
  /** 本机缓存的资料（登录成功那一行的名字） */
  C.who = function () { return effectiveProfile(readCache(), profileDefaults()); };

  /* ---------- 状态 / 票 ---------- */
  /** api.status() → 更新 st / 票 @returns {Promise<any>} */
  C.loadStatus = function () {
    return api.status().then(function (s) {
      if (!s) return null;
      C.status = s;
      correctSignedInMarker(doc, s);
      C.setSt(s.session ? 'in' : 'guest');
      C.reauthExp = s.reauth && s.reauth.expiresAt > Date.now() ? s.reauth.expiresAt : 0;
      C.resetExp = s.reset && s.reset.expiresAt > Date.now() ? s.reset.expiresAt : 0;
      return s;
    });
  };
  /** @param {string} s */
  C.setSt = function (s) {
    C.st = s;
    try { doc.documentElement.setAttribute('data-sgx-account-session', s === 'in' ? 'in' : 'out'); } catch (e) {}
    if (s) o.who.setAccount(s === 'in');
  };
  C.reauthLeft = function () { return C.reauthExp > Date.now() ? C.reauthExp - Date.now() : 0; };
  C.resetLeft = function () { return C.resetExp > Date.now() ? C.resetExp - Date.now() : 0; };
  /** @param {number} ms2 */
  C.mmss = function (ms2) { const s = Math.ceil(ms2 / 1000); return (s < 600 ? '0' : '') + Math.floor(s / 60) + ':' + ((s % 60) < 10 ? '0' : '') + (s % 60); };

  /* ---------- 功能模块 ---------- */
  mountSession(C);
  mountReauth(C);
  mountReset(C);
  mountKeys(C);
  mountDevices(C);
  mountGrants(C);
  mountProfile(C);
  mountProxy(C);
  /** 终端输出里的按钮（sub 的复制）：终端窗口点到 [data-at-act] 时调 @param {string} a */
  C.actLog = function (a) { return C.actProxy(a); };
  /** 服务端说没会话 / 票过期：401 lock → 没进站；401 reset → 结束 reset；401 account → 回没登录；403 reauth → 重新验证 @param {{s:number, j:any}} res @returns {boolean} */
  C.authErr = function (res) {
    if (api.isErr(res, api.ERR.lock)) { C.err(t('common.sessExp')); o.who.drop(); return true; }
    if (api.isErr(res, api.ERR.reset)) { C.endReset(true); return true; }
    if (api.isErr(res, api.ERR.account)) {
      C.setSt('guest');
      C.err(t('session.notSignedIn'), CMD.session);
      return true;
    }
    if (api.isErr(res, api.ERR.reauth)) {
      C.reauthExp = 0;
      C.err(t('reauth.expired'));
      return true;
    }
    return false;
  };

  /** 收起终端（登出、授权同意选完、只做再验证验完）；登录状态变了就重新载入 */
  C.finished = function () { o.term.close(); };
  /** 只做再验证：页面登记的、还在用这张 reauth 的事（做完或到点才结束 reauth） @type {Promise<void>|null} */
  let holdReauth = null;
  /** 终端关上之后：登录状态变了就重新载入（页面还在用 reauth 就等它做完） @param {Promise<void>|null} h */
  function afterTerm(h) {
    if (!C.loginChanged) return;
    C.loginChanged = false;
    if (h) h.then(function () { window.setTimeout(reload, 0); });
    else window.setTimeout(reload, 0);
  }
  /** 终端窗口关上：离开 reset（没选登出方式 = 不登出）、结束 reauth、忘掉印过的地址；登录状态变了就重新载入 */
  C.onTermClosed = function () {
    const h = holdReauth;
    holdReauth = null;
    if (C.inReset) { if (C.resetPending) C.toast(t('reset.signOut.pending')); C.inReset = false; C.resetPending = false; C.resetExp = 0; C.stopTick(); }
    C.consent = null;
    C.forgetProxy();
    afterTerm(h);
    if (!h) { C.endReauth(); return; }
    /* 页面还在用这张 reauth（奇趣导入）：做完再结束；这期间终端又打开了就交给那一次的关闭去结束 */
    h.then(function () { if (!o.term.shown()) C.endReauth(); });
  };

  /**
   * 只做再验证（[data-acct-open="reauth"]，奇趣导入书签要复验；和「关掉即失效」O12 一致，#327）：
   * 验过后在 document 上发 `sgx-account-reauthed`（detail.waitUntil(promise)），等页面在这一刻把要复验的事做完（奇趣：重发导入），
   * 然后收起终端；页面登记的事做完（最多 REAUTH_HOLD_MS）才结束 reauth。没人登记就收起时立刻结束。没登录先 sudo root（顺带 reauth）。
   */
  function onlyReauth() {
    const done = function () {
      /** @type {Promise<any>[]} */
      const waits = [];
      try {
        doc.dispatchEvent(new CustomEvent('sgx-account-reauthed', { detail: { waitUntil: function (/** @type {any} */ p) { waits.push(Promise.resolve(p).catch(function () {})); } } }));
      } catch (e) {}
      if (waits.length) {
        holdReauth = Promise.race([
          Promise.all(waits).then(function () {}),
          new Promise(function (r) { window.setTimeout(r, REAUTH_HOLD_MS); }),
        ]).then(function () {});
      }
      C.finished();
    };
    if (C.st === 'in') { C.echo(CMD.reauth); C.cmdReauth(done); }
    else { C.echo(CMD.session); C.verify({ withReauth: true, lead: t('session.lead'), done: done }); }
    C.focusIn();
  }

  /**
   * 页面上的入口（topbar-panel.js：[data-acct-open]、旧地址 #acct=reset|reauth、奇趣 / 日刻的 sudo root &app=…）：在终端里原地跑。
   * @param {{ reset?: boolean, reauth?: boolean, app?: string }} x
   */
  C.entry = function (x) {
    if (x.reset) { C.echo(CMD.reset); C.cmdReset(); C.focusIn(); return; }
    if (x.reauth) { onlyReauth(); return; }
    if (x.app) {
      C.consent = { app: x.app };
      if (C.st === 'in') { C.askConsent(); return; }
      C.echo(CMD.session);
      C.cmdSession();
      C.focusIn();
    }
  };
  /* 账号状态还没问过（这一页第一次用）就先问一次再跑（命令要看 st / 票） */
  ['cmdSession', 'cmdReauth', 'cmdReset', 'cmdExit', 'cmdPasswd', 'cmdPasskeyAdd', 'passkeyList', 'passkeyRm', 'deviceList', 'deviceRm', 'deviceRmAll', 'appList', 'appAllow', 'appDeny', 'profileShow', 'profileSet', 'profileAvatar', 'cmdSub', 'entry'].forEach(function (k) {
    const f = C[k];
    C[k] = function () {
      const args = arguments;
      if (C.status) return f.apply(C, args);
      C.setMode('busy');
      C.loadStatus().then(function () { C.toCmd(); f.apply(C, args); }, function () { C.toCmd(); f.apply(C, args); });
    };
  });

  try {
    /* 离开页面：reauth 结束（O12） */
    window.addEventListener('pagehide', function () { C.endReauth(); });
  } catch (e) {}

  /* 首帧登录标记说登录了：问一次账号接口，终端提示符按服务端的回答（root@account / styrigx@space） */
  try { if (firstFrameState(doc.cookie) === 'in') C.loadStatus(); } catch (e) {}

  return C;
}
