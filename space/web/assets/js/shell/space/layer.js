/**
 * @fileoverview 终端里的钥匙层（v5 S5 终端合一）：原锁屏 tty1 + 盾牌 tty3 的命令流程挂到同一个输入行上（shell/term/view/layer-ctx.js）。
 *
 * - sudo styrigx：终端里选方式 → 验证（session.js）→ 服务端确认 → 终端收起 → 开机动画（unlock.js）→ 回原页（guard.js proceed）
 * - sudo styrigx reset：reset 层（reset.js，reset@space:~#，不变）· sudo -v：再验证（reauth.js）
 * - lock / lock passwd / lock passkey [add | rm <n>] / lock --all（keys.js）· share …（links.js）
 * 后端只经 api.js；文案在外壳字符串表 space.*。终端身份（nobody / link / styrigx / root）只认服务端（shell/term/core/who.js），这里只在服务端说「没会话」时通知它。
 */
import { esc } from '../../lib/util.js';
import { profileDefaults, readCache, effectiveProfile } from '../../lib/profile.js';
import { layerCtx } from '../term/view/layer-ctx.js';
import { completerOf } from '../term/core/complete.js';
import { flatStrings, shellSection } from '../term/core/strings.js';
import * as api from './api.js';
import { CMD, RESET_TABLE, ADMIN_COMMAND } from './commands.js';
import { mountVerify } from './session.js';
import { mountReset } from './reset.js';
import { mountReauth } from './reauth.js';
import { mountKeys } from './keys.js';
import { mountLinks } from './links.js';
import { lockNow } from './lock-now.js';
import { bootSequence } from './unlock.js';
import { isLocalDev, askServer, proceed } from './guard.js';

/**
 * 外壳字符串表（#sgx-i18n-shell，当前语言已叠在英文上）的一节 → 取文案函数（缺键回 ''）。
 * @param {Document} doc @param {string} sec 例如 'space' @returns {(k: string) => string}
 */
export function shellTable(doc, sec) {
  const S = flatStrings(shellSection(doc, sec));
  return function (k) { return S[k] || ''; };
}

/** 名字（个人资料姓名；只是显示用，和会话判断无关） */
function profileName() {
  return effectiveProfile(readCache(), profileDefaults()).name;
}

/**
 * @param {any} line 终端输入行（input-line 的 C）
 * @param {{
 *   who: { refresh: () => Promise<any>, drop: () => void },
 *   close: (after: () => void) => void,
 *   reload: () => void,
 * }} o who = 终端身份；close = 收起终端窗口（收完再 after）；reload = 页面重新取一次（上锁之后，服务端画访客态）
 */
export function mountSpace(line, o) {
  const doc = document;
  const t = shellTable(doc, 'space');
  /** @param {string} k @param {Record<string, string|number>} v */
  const tf = function (k, v) { let s = t(k); for (const n in v) s = s.split('{' + n + '}').join(String(v[n])); return s; };
  const C = layerCtx(line, { t: t, tf: tf, esc: esc, api: api, cfg: null });
  C.who = profileName;
  C.completeReset = completerOf(RESET_TABLE);
  /* reset 层的状态栏 / 胶囊（原锁屏头部）没有了：提示符已经是 reset@space:~# */
  C.setBar = function () {};
  C.setStatus = function () {};

  /** 服务端说没会话 / 票过期 / 分享链接会话：回 true = 这一下处理了 @param {{s:number, j:any}} res @returns {boolean} */
  C.authErr = function (res) {
    if (api.isErr(res, api.ERR.session) || (res && res.s === 401 && !(res.j && res.j.error))) {
      C.err(t('common.sessExp'), CMD.session);
      o.who.drop();
      return true;
    }
    if (api.isErr(res, api.ERR.reauth)) {
      C.reauthExp = 0;
      C.err(t('reauth.expired'), CMD.reauth);
      return true;
    }
    if (api.isErr(res, 'link')) {
      C.err(t('common.errLink'));
      return true;
    }
    return false;
  };

  mountVerify(C);
  mountReset(C);
  mountReauth(C);
  mountKeys(C);
  mountLinks(C);

  /* ---------- sudo styrigx：进站 ---------- */
  let unlocking = false;
  C.unlock = function () {
    C.setMode('busy');
    api.entryConfig().then(function (cfg) {
      C.cfg = cfg;
      C.toCmd();
      C.verify({ lead: t('session.lead'), done: unlocked });
    });
  };
  /** 验证过了：先向服务端确认会话真的生效，再收起终端、放动画、按服务端给的去处走 @param {string} by */
  function unlocked(by) {
    if (unlocking) return;
    unlocking = true;
    C.out('› ' + esc(t('entry.verifying')) + '…', 'd');
    C.setMode('busy');
    const go = function (/** @type {any} */ ans) {
      C.ok('✓ access granted');
      C.out('› booting space…', 'd');
      C.setMode('done');
      const user = (String(profileName() || '').trim().split(/\s+/)[0] || ADMIN_COMMAND).toLowerCase();
      o.close(function () {
        const anim = bootSequence(ans, by, user, function () {
          if (isLocalDev()) { o.who.refresh(); anim.done(); unlocking = false; C.toCmd(); return; }
          proceed(ans, function () { o.who.refresh(); anim.done(); unlocking = false; C.toCmd(); });
        });
      });
    };
    if (isLocalDev()) { go({ ok: true, by: by }); return; }
    askServer().then(function (ans) {
      if (ans.ok) { go(ans); return; }
      unlocking = false;
      C.err(t('entry.notRecognized'));
      C.toCmd();
    });
  }

  /* ---------- lock：立即上锁（只锁本机，不验证）→ 页面重新取一次（服务端画访客态） ---------- */
  C.relocked = function () {
    o.who.drop();
    C.setMode('done');
    o.close(o.reload);
  };
  C.lockNow = function () {
    C.out('› ' + esc(t('shield.locking')), 'd');
    C.setMode('busy');
    lockNow(api).then(function (ok) {
      if (ok) { C.relocked(); return; }
      C.err(t('shield.lockFail'));
      C.toCmd();
    });
  };

  /** 已进站点盾牌（v5 S6，Gray 16:36）：问「退出进站会话 [y/N]」——y = lock（同上，只锁本机），回车 / n 不动 */
  C.lockAsk = function () {
    C.out(esc(t('shield.exitAsk')) + ' [y/N]');
    C.pick({
      y: function () { C.echoPick('y'); C.lockNow(); },
      n: function () { C.echoPick('n'); C.toCmd(); },
    }, 'n', { ps: '[y/N]' });
  };

  /** 终端窗口关上：结束 reauth；钥匙 reset 里关窗口 = 离开 reset */
  C.onTermClosed = function () {
    if (C.inReset) C.leaveReset();
    C.endReauth();
  };
  return C;
}
