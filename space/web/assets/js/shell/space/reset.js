/**
 * @fileoverview `sudo styrigx reset`：钥匙的 reset 层（提示符 reset@space:~#，SPACE-V3 §2.2 B；v5 S5 起在同一个终端里，层不变）。
 *
 * `[sudo] recovery key:`（不回显）→ 恢复钥匙一把就签 3 分钟 reset 票（Gray B，没有第二次验证），不签进站会话。
 * reset 里：passwd（new / retype，≥ 8 位）· passkey ls · passkey add（先问名字，Q9）· passkey rm <n>（[y/N]）· man · clear · exit。
 * 第一次改动后问一次「其他设备怎么办？ [1] 全部回锁屏（默认，回车） [2] 不动」（Q1 两选）→ finish；finish 后 reset 票失效（Q2），
 * 回命令行，用新的密码 / 通行密钥 sudo styrigx 进站。有改动没选就离开（exit / ^C / esc）= 不动，并提示一行。
 * 写入都不推纪元（服务端 L8）。不跳 /security/lock/（那一页已删）。
 */
import { registerPasskey, genPkPrefillName, cleanPasskeyName } from '../../auth/passkey-register.js';
import { CMD, PS_RECOVERY_KEY, MAX_TRIES, TRIES_OVER, TRY_AGAIN, normCmd, parseResetCmd, mmdd, passkeyName } from './commands.js';
import { suggest } from '../suggest.js';

/** reset 票时长（毫秒；服务端 SHORT_TICKET_MAX_AGE = 180 秒，前端只拿来显示倒计时） */
export const RESET_MS = 180000;
/** 两选：键 → signOut */
export const SIGN_OUT_CHOICES = Object.freeze([['1', 'all'], ['2', 'none']]);

/** @param {any} C 钥匙层上下文（shell/space/layer.js） */
export function mountReset(C) {
  const t = C.t;
  const tf = C.tf;
  const api = C.api;
  const esc = C.esc;
  C.inReset = false;
  /** 这一轮 reset 里改过东西、还没选其他设备怎么办 */
  C.resetPending = false;
  C.resetExp = 0;
  /** @type {any[]} */ let keyList = [];
  let tick = 0;

  C.cmdReset = function () {
    C.tries = 0;
    C.out(esc(t('reset.lead')));
    askRecoveryKey();
  };
  function askRecoveryKey() {
    C.ask('rkey', function (/** @type {string} */ val) {
      C.setMode('busy');
      api.reset.recoveryKey(val).then(function (/** @type {any} */ res) {
        if (res.j && res.j.ok) { enter(); return; }
        if (res.s === 429 || api.isErr(res, api.ERR.cooldown)) { C.err(t('common.tooMany')); C.toCmd(); return; }
        if (api.isErr(res, api.ERR.config)) { C.err(t('common.errConfig')); C.toCmd(); return; }
        if (res.s === 401) {
          C.tries++;
          if (C.tries >= MAX_TRIES) { C.err(TRIES_OVER); C.toCmd(); return; }
          C.err(TRY_AGAIN);
          askRecoveryKey();
          return;
        }
        C.err(api.errText(t, res.j && res.j.error, res.s));
        C.toCmd();
      }, function () { C.err(t('common.errNetwork')); C.toCmd(); });
    }, { ps: PS_RECOVERY_KEY, pm: api.PM_USER.recoveryKey, hint: t('common.hidden'), aria: t('reset.recoveryKeyAria') });
  }

  function enter() {
    C.inReset = true;
    C.resetPending = false;
    C.resetExp = Date.now() + RESET_MS;
    keyList = [];
    C.ok('✓ verified', t('reset.ok'));
    C.note(t('reset.cmds'));
    C.toCmd();
    C.setStatus('reset');
    startTick();
    C.focusIn(true);
  }

  function startTick() {
    stopTick();
    const paint = function () {
      const left = C.resetExp - Date.now();
      if (!C.inReset) { stopTick(); return; }
      if (left <= 0) { stopTick(); C.err(t('reset.expired'), CMD.reset); endReset(); return; }
      C.setBar('reset · ' + mmss(left));
    };
    paint();
    tick = window.setInterval(paint, 1000);
  }
  function stopTick() { if (tick) { window.clearInterval(tick); tick = 0; } }
  /** @param {number} ms */
  function mmss(ms) { const s = Math.ceil(ms / 1000); return Math.floor(s / 60) + ':' + ((s % 60) < 10 ? '0' : '') + (s % 60); }

  /** 离开 reset（不调接口）：回锁屏命令行 */
  function endReset() {
    stopTick();
    C.inReset = false;
    C.resetPending = false;
    C.resetExp = 0;
    keyList = [];
    C.setBar('');
    C.setStatus('');
    C.toCmd();
  }

  /** 主动离开（exit / ^C / esc）：改过没选 = 不动（finish none，提示一行）；没改过 = reset end */
  C.leaveReset = function () {
    if (!C.inReset) return;
    if (C.resetPending) {
      C.warn(t('reset.signOut.pending'));
      api.reset.finish('none').catch(function () {});
    } else {
      api.reset.end().catch(function () {});
    }
    endReset();
    C.note(t('reset.leftNow'), CMD.session);
  };

  /** reset 票失效（服务端 401 reset） @param {any} res */
  function resetLost(res) {
    if (!api.isErr(res, api.ERR.reset) && !(res && res.s === 401)) return false;
    C.err(t('reset.expired'), CMD.reset);
    endReset();
    return true;
  }

  /** @param {string} raw */
  C.runResetCmd = function (raw) {
    const line = normCmd(raw);
    if (!line) return;
    C.echo(raw.trim());
    const c = parseResetCmd(line);
    switch (c.cmd) {
      case 'man': man(); return;
      case 'clear': C.clearLog(); return;
      case 'exit': C.leaveReset(); return;
      case 'passwd': passwd(); return;
      case 'passkey-ls': listKeys(true); return;
      case 'passkey-add': addPasskey(); return;
      case 'passkey-rm': removeKey(c.arg || ''); return;
      default: {
        /* 打错了：给最近的真命令（Gray 2026-11-09） */
        const sg = suggest(line, ['man', 'clear', 'exit', 'passwd', 'passkey ls', 'passkey add', 'passkey rm']);
        if (sg) C.err(tf('common.didYouMean', { c: raw.trim().split(' ')[0] }), sg);
        else C.err(tf('common.notFound', { x: raw.trim().split(' ')[0] }));
      }
    }
  };
  function man() {
    const rows = [['passwd', t('reset.help.passwd')], ['passkey ls', t('reset.help.ls')], ['passkey add', t('reset.help.add')], ['passkey rm <n>', t('reset.help.rm')], ['exit', t('reset.help.exit')], ['clear', t('reset.help.clear')]];
    rows.forEach(function (r) { C.out('<span class="' + C.p + '-w">' + esc(r[0]) + '</span> — ' + esc(r[1])); });
    C.note(t('reset.help.note'));
  }

  function passwd() {
    const pm = { pm: api.PM_USER.password, hint: t('common.hidden') };
    C.ask('newpw', function (/** @type {string} */ v1) {
      if (v1.length < 8) { C.err(t('keys.password.short')); C.toCmd(); return; }
      C.ask('newpw2', function (/** @type {string} */ v2) {
        if (v2 !== v1) { C.err(t('keys.password.mismatch')); C.toCmd(); return; }
        C.setMode('busy');
        api.reset.passwordSet(v2).then(function (/** @type {any} */ res) {
          if (res.j && res.j.ok) { C.ok(t('keys.password.updated')); C.toCmd(); changed(); return; }
          if (resetLost(res)) return;
          C.err(api.errText(t, res.j && res.j.error, res.s));
          C.toCmd();
        }, function () { C.err(t('common.errNetwork')); C.toCmd(); });
      }, Object.assign({ ps: t('keys.password.retype') }, pm));
    }, Object.assign({ ps: t('keys.password.new') }, pm));
  }

  /** @param {boolean} print @returns {Promise<boolean>} */
  function listKeys(print) {
    C.setMode('busy');
    return api.reset.passkeyList().then(function (/** @type {any} */ res) {
      if (res.j && res.j.ok) {
        keyList = res.j.keys || [];
        if (print) {
          if (!keyList.length) C.note(t('keys.none'));
          keyList.forEach(function (/** @type {any} */ k, /** @type {number} */ i) {
            C.out('<span class="' + C.p + '-p">[' + (i + 1) + ']</span> <span translate="no" data-sgx-personal>' + esc(passkeyName(k, t)) + '</span> <span class="' + C.p + '-dim">· ' + esc(tf('keys.created', { d: mmdd(k.createdAt) })) + '</span>');
          });
        }
        C.toCmd();
        return true;
      }
      if (!resetLost(res)) { C.err(api.errText(t, res.j && res.j.error, res.s)); C.toCmd(); }
      return false;
    }, function () { C.err(t('common.errNetwork')); C.toCmd(); return false; });
  }

  function addPasskey() {
    if (!(/** @type {any} */ (window)).PublicKeyCredential) { C.err(t('common.pkNoSupport')); return; }
    const dflt = genPkPrefillName('');
    C.out(esc(t('keys.nameAsk')) + (dflt ? ' [' + esc(dflt) + ']' : '') + ':');
    C.ask('pkname', function (/** @type {string} */ v) {
      const name = cleanPasskeyName(v) || dflt;
      C.setMode('busy');
      C.out('› ' + esc(t('session.passkeyWait')), 'd');
      const toRes = function (/** @type {any} */ r) { return { status: r.s, json: r.j }; };
      let done = false;
      registerPasskey({
        challenge: function () { return api.reset.passkeyAddChallenge().then(toRes); },
        register: function (/** @type {any} */ body) { return api.reset.passkeyAdd(body).then(toRes); },
        onAuthError: function (/** @type {any} */ res) { return resetLost({ s: res.status, j: res.json }); },
        onRegistered: function () { done = true; C.ok('✓ ' + t('keys.registered')); keyList = []; C.toCmd(); changed(); },
        prefill: function () { return name; },
        errText: function (/** @type {string} */ c, /** @type {number} */ s) { return api.errText(t, c, s); },
        toast: function (/** @type {string} */ m) { C.err(m); },
        msg: { cancelled: t('common.cancelled'), already: t('keys.already'), noSupport: t('common.pkNoSupport'), failed: t('keys.failed'), network: t('common.errNetwork') },
      }).then(function () { if (!done && C.mode === 'busy' && C.inReset) C.toCmd(); });
    }, { ps: '>', hint: t('keys.nameHint') });
  }

  /** @param {string} n 第几把（passkey ls 的编号） */
  function removeKey(n) {
    const go = function () {
      const i = parseInt(n, 10) - 1;
      const key = keyList[i];
      if (!key) { C.err(t('keys.noSuch')); C.note(t('keys.lsFirst'), 'passkey ls'); return; }
      const nm = passkeyName(key, t);
      C.out(esc(tf('keys.rmAsk', { n: nm })) + ' [y/N]');
      C.pick({
        y: function () {
          C.echoPick('y');
          C.setMode('busy');
          api.reset.passkeyDelete(key.credId).then(function (/** @type {any} */ res) {
            if (res.j && res.j.ok) { C.ok('✓ ' + t('keys.deleted')); keyList = []; C.toCmd(); changed(); return; }
            if (resetLost(res)) return;
            C.err(api.isErr(res, api.ERR.lastKey) ? t('keys.lastKey') : api.errText(t, res.j && res.j.error, res.s));
            C.toCmd();
          }, function () { C.err(t('common.errNetwork')); C.toCmd(); });
        },
        n: function () { C.echoPick('n'); C.toCmd(); },
      }, 'n', { ps: '[y/N]' });
    };
    if (!n) { C.err('usage: passkey rm <n>'); return; }
    if (keyList.length) { go(); return; }
    listKeys(false).then(function (ok) { if (ok) go(); });
  }

  /** 第一次改动后：两选顶到终端最下面（Q1）。只在 reset 里、还没选过时出 */
  function changed() {
    if (!C.inReset || C.resetPending) return;
    C.resetPending = true;
    C.out(esc(t('reset.ask')));
    C.opts(SIGN_OUT_CHOICES.map(function (c) { return /** @type {[string, string, boolean?]} */ ([c[0], t('reset.signOut.' + c[1]), c[1] === 'all']); }));
    C.note(t('reset.signOut.default'));
    /** @type {Record<string, () => void>} */ const picks = {};
    SIGN_OUT_CHOICES.forEach(function (c) {
      picks[c[0]] = function () {
        C.echoPick(c[0]);
        C.setMode('busy');
        api.reset.finish(/** @type {any} */ (c[1])).then(function (/** @type {any} */ res) {
          if (!(res.j && res.j.ok)) {
            if (resetLost(res)) return;
            C.err(api.errText(t, res.j && res.j.error, res.s));
            C.pick(picks, '1');
            return;
          }
          C.resetPending = false;
          C.ok('✓ ' + t(c[1] === 'all' ? 'reset.signOut.allDone' : 'reset.signOut.kept'));
          endReset();
          C.note(t('reset.finished'), CMD.session);
        }, function () { C.err(t('common.errNetwork')); C.pick(picks, '1'); });
      };
    });
    /* ^C / esc 在这一步 = 离开 reset（没选 = 不动） */
    C.onCancel = function () { C.leaveReset(); };
    C.pick(picks, '1');
  }
}
