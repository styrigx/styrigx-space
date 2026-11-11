/**
 * @fileoverview 全站终端里的账号层（v5 S5 终端合一；S9 起账号的所有操作都在这里，账号卡片 shell/account/window.js 只展示）。
 *
 * 终端里的账号命令（shell/term/cmds/acct、sub）调这里挂在 C 上的流程：passkey（./keys.js）、device（./devices.js）、
 * profile（./profile.js）、sub（../proxy.js）。命令先由终端按 v6 身份把门（cmds/keys/gate.js），服务端再按路由档判。
 * 要输入、选择的都在终端里原地做完；输出 / 输入模式走终端的输入行（shell/term/view/layer-ctx.js）。后端只在 ../api.js。
 * v6 P4（定稿 v5.2 §十三）起旧账号会话（sudo root 登录 / sudo root reauth / sudo root reset、GET /api/account 状态、登录标记 sgx-account-signed-in）删除。
 *
 * 只 import lib/、auth/、shell/（check-layers 规则 3）。文案在外壳字符串表 account.*（sgx-shell-i18n），四个站同一份。
 */
import { esc } from '../../../lib/util.js';
import { toast } from '../../../lib/toast.js';
import { readCache, effectiveProfile, profileDefaults } from '../../../lib/profile.js';
import { flatStrings } from '../../term/core/strings.js';
import { layerCtx } from '../../term/view/layer-ctx.js';
import * as api from '../api.js';
import { mountProxy } from '../proxy.js';
import { mountKeys } from './keys.js';
import { mountDevices } from './devices.js';
import { mountProfile } from './profile.js';
import { mountV6Direct } from './v6-direct.js';

/**
 * @typedef {Object} TermLink 终端那一头（topbar-panel.js 给）
 * @property {(after?: () => void) => void} close 收起终端窗口
 * @property {() => boolean} shown 终端窗口开着
 */

/**
 * @param {{
 *   S: any,
 *   line: any,
 *   who: { refresh?: () => any },
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
  const errT = function (k) { return k === 'devCurrent' ? t('devices.currentHint') : t('common.' + k); };
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
  });
  /** 注释行 `# …`（这里传文案键；{x} 换成黄色命令） @param {string} key @param {string} [x] */
  C.note = function (key, x) { C.out('# ' + esc(t(key)).replace('{x}', x ? C.k(x) : ''), 'd'); };
  /** 服务端错误码 → 红字 @param {{s: number, j: any}} res */
  C.apiErr = function (res) { C.err(api.errText(errT, res && res.j && res.j.error, res && res.s)); };
  C.netErr = function () { C.err(t('common.errNetwork')); };
  /** 这一条命令走不走 sudo（定稿 v5.5 §四、§七；api.js setSudo）：sudo device / sudo sub 给证明来源，其余命令开始前清掉 @param {null | (() => Promise<any>)} via */
  C.sudo = function (via) { api.setSudo(via); };
  /** 本机缓存的资料（登录成功那一行的名字） */
  C.who = function () { return effectiveProfile(readCache(), profileDefaults()); };

  /* ---------- 功能模块 ---------- */
  mountKeys(C);
  mountDevices(C);
  mountProfile(C);
  mountProxy(C);
  /** 终端输出里的按钮（sub 的复制）：终端窗口点到 [data-at-act] 时调 @param {string} a */
  C.actLog = function (a) { return C.actProxy(a); };
  /* v6 的 401 / 403 提示（C.gated / C.authErrFor / C.authErr，见 ./v6-direct.js） */
  mountV6Direct(C, o.who);

  /** 终端窗口关上：忘掉印过的地址 */
  C.onTermClosed = function () { C.forgetProxy(); };

  return C;
}
