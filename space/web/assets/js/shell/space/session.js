/**
 * @fileoverview `sudo styrigx`（锁屏进站）和 `sudo styrigx reauth`（盾牌再验证）共用的「选方式 → 验证」（SPACE-V3 §2.2 A / C）。
 *
 * - 锁屏：[pick] 只列设了的 [1] passkey [2] password，[3] tempkey 一直在；`sudo styrigx passkey|password|tempkey` 跳过选择。
 * - reauth：只列设了的 passkey / password（没有 tempkey，reauth 只认解锁密码 / 通行密钥，Gray C）。
 * - 没设的方式直接点名：`<方式>：未设置` + 列出能用的，回命令行。
 * - 三次规则（同账号 O19）：输错 `Sorry, try again.` 同一行再问；第 3 次 `sudo: 3 incorrect password attempts` 回命令行；
 *   通行密钥取消 / 失败算 1 次、回到选择；数字不对「没有这个选项」不算次数；服务端冷却 → 倒计时行 → 命令行。
 * 后端只经 api.js。
 */
import { psPassword, availableKinds, PS_TEMPKEY, MAX_TRIES, TRIES_OVER, TRY_AGAIN, CMD } from './commands.js';

/** 本机支持通行密钥 */
export function pkSupported() {
  try { return !!(/** @type {any} */ (window)).PublicKeyCredential; } catch (e) { return false; }
}

/**
 * @param {any} C 终端上下文（term.js createTerm 的结果，宿主另挂：api、tf、cfg（{password, passkey}|null）、who()（名字）、authErr(res)、localDev）
 */
export function mountVerify(C) {
  const t = C.t;
  const api = C.api;
  const esc = C.esc;

  /** 方式说明（只列给了的） @param {string[]} ks */
  function keyMap(ks) { return ks.map(function (k) { return t('session.kind.' + k); }).join(' · '); }

  /**
   * 选方式 → 验证。
   * @param {{reauth?: boolean, only?: string, lead?: string, done: (by: string) => void, fail?: () => void}} v
   */
  C.verify = function (v) {
    C.tries = 0;
    const ks = availableKinds(C.cfg, pkSupported(), !v.reauth);
    if (v.only) {
      if (ks.indexOf(v.only) === -1) {
        C.err(C.tf('session.notSet', { k: v.only }));
        const can = ks.filter(function (k) { return k !== v.only; });
        if (can.length) C.note(C.tf('session.canUse', { x: can.map(function (k) { return (v.reauth ? CMD.reauth : CMD.session) + ' ' + k; }).join(' · ') }));
        else if (!v.reauth) C.note(t('session.noCred'), CMD.reset);
        if (v.fail) v.fail();
        C.toCmd();
        return;
      }
      if (v.lead) C.out(esc(v.lead));
      run(v, v.only, false);
      return;
    }
    if (v.lead) C.out(esc(v.lead));
    const creds = ks.filter(function (k) { return k !== 'tempkey'; });
    if (!creds.length) {
      if (v.reauth) { C.err(t('reauth.none')); if (v.fail) v.fail(); C.toCmd(); return; }
      C.note(t('session.noCred'), CMD.reset);
    }
    C.out('# ' + esc(keyMap(ks)), 'd');
    offer(v, ks);
  };

  /** 列选项 @param {any} v @param {string[]} ks */
  function offer(v, ks) {
    const list = /** @type {Array<[string, string, boolean?]>} */ ([]);
    /** @type {Record<string, () => void>} */ const p = {};
    ks.forEach(function (kk, i) {
      const key = String(i + 1);
      list.push([key, kk]);
      p[key] = function () { C.echoPick(key); run(v, kk, true, ks); };
      p[kk] = p[key];
    });
    C.opts(list);
    C.onCancel = v.fail || null;
    C.pick(p, '', { ps: t('session.pick') + ' [' + ks.map(function (_, i) { return i + 1; }).join('/') + ']:' });
  }

  /** @param {any} v @param {string} kind @param {boolean} fromPick @param {string[]} [ks] */
  function run(v, kind, fromPick, ks) {
    if (kind === 'password') askPw(v);
    else if (kind === 'tempkey') askTemp(v);
    else viaPasskey(v, fromPick ? ks : null);
  }

  /** 一次输错：还在这一轮就再问，满 3 次结束 @param {any} v @param {() => void} again */
  function wrong(v, again) {
    C.tries++;
    if (C.tries >= MAX_TRIES) { C.err(TRIES_OVER); if (v.fail) v.fail(); C.toCmd(); return; }
    C.err(TRY_AGAIN);
    again();
  }

  /** @param {any} v */
  function askPw(v) {
    C.ask('pw', function (/** @type {string} */ val) {
      C.setMode('busy');
      const call = v.reauth ? api.reauth.password(val) : api.session.password(val);
      call.then(function (/** @type {any} */ res) {
        if (res.j && res.j.ok) { v.done('password'); return; }
        if (res.s === 429 || api.isErr(res, api.ERR.cooldown)) { cooldown(res, 30); if (v.fail) v.fail(); C.toCmd(); return; }
        if (api.isErr(res, api.ERR.notSet)) { C.err(C.tf('session.notSet', { k: 'password' })); if (v.fail) v.fail(); C.toCmd(); return; }
        if (api.isErr(res, api.ERR.wrong)) { wrong(v, function () { askPw(v); }); return; }
        if (C.authErr(res)) { C.toCmd(); return; }
        C.err(api.errText(t, res.j && res.j.error, res.s));
        if (v.fail) v.fail();
        C.toCmd();
      }, function () { C.err(t('common.errNetwork')); if (v.fail) v.fail(); C.toCmd(); });
    }, { ps: psPassword(C.who()), pm: api.PM_USER.password, hint: t('common.hidden') });
  }

  /** @param {any} v */
  function askTemp(v) {
    if (C.localDev) { v.done('tempkey'); return; }
    C.ask('temp', function (/** @type {string} */ val) {
      const code = val.trim();
      if (!code) { askTemp(v); return; }
      C.setMode('busy');
      api.session.tempkey(code).then(function (/** @type {any} */ res) {
        if (res.j && res.j.ok) { v.done('tempkey'); return; }
        if (res.s === 429 || api.isErr(res, api.ERR.cooldown)) { cooldown(res, 15 * 60); if (v.fail) v.fail(); C.toCmd(); return; }
        if (api.isErr(res, api.ERR.wrong)) { wrong(v, function () { askTemp(v); }); return; }
        C.err(api.errText(t, res.j && res.j.error, res.s));
        if (v.fail) v.fail();
        C.toCmd();
      }, function () { C.err(t('common.errNetwork')); if (v.fail) v.fail(); C.toCmd(); });
    }, { ps: PS_TEMPKEY, pm: api.PM_USER.password, hint: t('session.tempkeyFormat') });
  }

  /** 等通行密钥时可 ^C / esc（busyCancel）：之后回来的结果作废，也不再提交断言 */
  let pkSeq = 0;
  /** @param {any} v @param {string[]|null} ks 从选择进来的（失败回到选择）；null = 直达（失败回命令行） */
  function viaPasskey(v, ks) {
    if (!pkSupported()) { C.err(t('common.pkNoSupport')); if (ks) again(v, ks); else C.toCmd(); return; }
    const my = ++pkSeq;
    const stale = function () { return my !== pkSeq; };
    C.setMode('busy', { cc: true });
    C.busyCancel = function () { pkSeq++; if (v.fail) v.fail(); };
    C.out('› ' + esc(t('session.passkeyWait')), 'd');
    const call = v.reauth ? api.reauth.passkey(t, stale) : api.session.passkey(t, stale);
    call.then(function () { if (stale()) return; C.busyCancel = null; v.done('passkey'); }, function (/** @type {any} */ e) {
      if (stale()) return;
      C.busyCancel = null;
      if (e && e.code === 'session' && C.authErr({ s: 401, j: { error: 'session' } })) { C.toCmd(); return; }
      C.out(esc(e && e.cancelled ? t('common.cancelled') : (e && e.message) || t('common.errVerify')), e && e.cancelled ? 'd' : 'er');
      if (ks) again(v, ks);
      else { if (v.fail) v.fail(); C.toCmd(); }
    });
  }
  /** 通行密钥没成：还在这一轮（< 3 次）就重新列选项，满 3 次结束这一轮 @param {any} v @param {string[]} ks */
  function again(v, ks) {
    C.tries++;
    if (C.tries >= MAX_TRIES) { C.err(TRIES_OVER); if (v.fail) v.fail(); C.toCmd(); return; }
    offer(v, ks);
  }

  /**
   * 服务端冷却：一行倒计时（走完自己收掉）。retryAfter（秒）是网关给的；没有就用这种方式自己的默认冷却。
   * @param {any} res @param {number} fallbackSec
   */
  function cooldown(res, fallbackSec) {
    const sec = res && res.j && res.j.retryAfter > 0 ? Number(res.j.retryAfter) : fallbackSec;
    const until = Date.now() + sec * 1000;
    C.err(t('common.tooMany'));
    const line = C.out('', 'd');
    const tick = function () {
      const left = until - Date.now();
      if (left <= 0 || !line.isConnected) { if (line.parentNode) line.parentNode.removeChild(line); return; }
      line.textContent = '› ' + (left >= 120000 ? C.tf('common.retryMin', { n: Math.ceil(left / 60000) }) : C.tf('common.retrySec', { n: Math.ceil(left / 1000) }));
      window.setTimeout(tick, left >= 120000 ? 5000 : 1000);
    };
    tick();
  }
}
