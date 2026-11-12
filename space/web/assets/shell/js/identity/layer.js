/**
 * @fileoverview 全站终端里的 v6 身份层（P2b，定稿 v4 §六 / §七 / §八；命令手册 docs/specs/v6-identity-migration.md）。
 *
 * 终端命令（shell/term/cmds/ident、keys/sudo.js、base/exit.js、keys/lock.js、acct passwd）在有 v6 新会话或用 v6 写法时调这里：
 * su <用户> / su root、sudo <命令>、exit、lock、whoami、groups、who、useradd / userdel / usermod、passwd / passwd <名>；P3 救援入口 rescue（§九）。
 * 前台空闲计时（Page Visibility）：root 层前台空闲 15 分钟 → POST idle 弹回普通用户；页面隐藏 / 锁屏时暂停计时。
 * 输出 / 输入模式 / 秘密输入走终端的输入行（shell/term/view/layer-ctx.js）；后端只在 ./api.js。旧入口（sudo styrigx / sudo root / lock passwd …）不经这里。
 *
 * 只 import lib/、auth/、shell/（check-layers 规则 3）。文案在外壳字符串表 identity 节（sgx-shell-i18n），四个站同一份。
 */
import { esc } from '../core/util.js';
import { flatStrings, shellSection } from '../term/core/strings.js';
import { layerCtx } from '../term/view/layer-ctx.js';
import * as api from './api.js';
import { USER_NAME_RE, sudoCommand } from '../term/core/ident-args.js';

export { USER_NAME_RE, SUDO_CMDS, parseUseradd, parseUsermod, sudoCommand } from '../term/core/ident-args.js';

/** 前台空闲多久弹回（毫秒；服务端 whoami 的 idleMs 为准，这里是缺省） */
export const ROOT_IDLE_MS = 15 * 60 * 1000;
/** 空闲计时的步长（毫秒） */
export const IDLE_TICK_MS = 15 * 1000;

/**
 * 前台空闲计时（纯逻辑，可测）：可见时累计没有操作的时间，隐藏时不累计；有操作清零；到 idleMs 调 onIdle 一次（之后要 reset 才再计）。
 * @param {{ idleMs: number, visible: () => boolean, onIdle: () => void }} o
 */
export function createIdleClock(o) {
  let idle = 0;
  let fired = false;
  return {
    /** 用户动了一下 */
    activity: function () { idle = 0; fired = false; },
    /** 过了 ms 毫秒（计时器每步调） @param {number} ms */
    tick: function (ms) {
      if (fired || !o.visible()) return;
      idle += ms;
      if (idle >= o.idleMs) { fired = true; o.onIdle(); }
    },
    reset: function () { idle = 0; fired = false; },
    idle: function () { return idle; },
  };
}

/**
 * @param {{ S: any, line: any, who: any, doc?: Document }} o S = 外壳字符串表的 identity 节；line = 终端输入行；who = 终端身份（core/who.js）
 */
export function mountIdentityLayer(o) {
  const doc = o.doc || document;
  const S = flatStrings(o.S || {});
  /** @param {string} k @param {Record<string, string>} [v] */
  const t = function (k, v) { let s = S[k] || k; for (const n in (v || {})) s = s.split('{' + n + '}').join(String(/** @type {any} */ (v)[n])); return s; };
  const who = o.who;

  const C = layerCtx(o.line, { t: t, api: api });

  /** 服务端回来的 user → 身份（提示符重画） @param {any} u */
  function setUser(u) { who.setV6(u || null); armIdle(); }
  /** 当前 v6 身份（whoami 的 user） */
  function me() { return who.v6 ? who.v6() : null; }
  C.hasSession = function () { return !!me(); };

  /** 错误码 → 一行红字 @param {{s:number, j:any}} r @param {string} [cmd] */
  function fail(r, cmd) {
    const j = (r && r.j) || {};
    const e = j.error || '';
    if (e === 'identity') {
      /* 提示符上的身份和服务端认定的对不上（root 层失效）：不执行，切到服务端回的真实身份 */
      const was = (me() || {}).name || '';
      setUser(j.user || null);
      C.err(t(j.lapsed === 'timeout' ? 'layerTimeout' : 'layerGone', { r: was, u: j.user ? j.user.name : '' }), 'su ' + was);
      return;
    }
    const map = {
      auth: t('authFail'), cooldown: t('cooldown'), 'exit-first': t('exitFirst', { u: (me() || {}).name || '' }), 'already-root': t('alreadyRoot'),
      'root-creds': t('rootCreds'), temporary: t('temporary', { g: j.group || '' }), group: t('group', { g: j.group || '' }), expiry: t('expiry'),
      name: t('name'), exists: t('exists'), 'not-found': t('notFound'), protected: t('protected'), weak: t('weak'), unauthorized: t('notSignedIn'),
      permission: j.need === 'wheel' ? t('notWheel') : t('permission', { c: cmd || '' }),
      /* 未知命令（服务端 action）= 终端现成的「找不到命令」（term.notFound；普通用户进 wheel / sudoers / 写组同样报它，Gray 11-11 22:36） */
      action: String(shellSection(doc, 'term').notFound || 'command not found: {x} · try man'),
    };
    C.err(/** @type {any} */ (map)[e] || t('unknown', { c: e || String(r && r.s) }), e === 'action' ? String(cmd || '').split(' ')[0] : undefined);
    if (e === 'permission' && j.need === 'root' && cmd) C.note(t('trySudo'), 'sudo ' + cmd);
  }
  function net() { C.err(t('network')); C.toCmd(); }

  /**
   * 选验证方式（密码 / 通行密钥）→ 拿到证明 → next(proof)。prompt = 密码提示符。
   * @param {string} prompt @param {'su-challenge'|'sudo-challenge'} ch @param {(proof: any) => void} next
   */
  function proofOf(prompt, ch, next) {
    const viaPw = function () {
      C.ask('pw', function (/** @type {string} */ v) { next({ password: v }); }, { ps: prompt, hint: t('hidden') });
    };
    if (!(/** @type {any} */ (window)).PublicKeyCredential) { viaPw(); return; }
    C.opts([['1', t('kindPassword'), true], ['2', t('kindPasskey')]]);
    C.pick({
      1: function () { C.echoPick('1'); viaPw(); },
      2: function () {
        C.echoPick('2');
        C.setMode('busy', { cc: true });
        C.out(esc(t('passkeyWait')), 'd');
        api.passkeyProof(ch).then(next, function (/** @type {any} */ e) {
          C.out(esc(e && e.cancelled ? t('cancelled') : t('authFail')), e && e.cancelled ? 'd' : 'er');
          C.toCmd();
        });
      },
    }, '1');
  }

  /** 新密码两次 → fn(pw) @param {(pw: string) => void} fn */
  function newPassword(fn) {
    C.ask('newpw', function (/** @type {string} */ a) {
      C.ask('newpw2', function (/** @type {string} */ b) {
        if (a !== b) { C.err(t('mismatch')); C.toCmd(); return; }
        fn(a);
      }, { ps: t('newPw2'), hint: t('hidden') });
    }, { ps: t('newPw'), hint: t('hidden') });
  }

  /* ---------- su ---------- */
  /** @param {string} target */
  C.cmdSu = function (target) {
    if (target === 'root') {
      const u = me();
      if (!u) { C.err(t('notSignedIn')); return; }
      if (u.root) { C.warn(t('alreadyRoot')); return; }
      if (!u.wheel) { C.err(t('notWheel')); return; }
      /* su 输的是目标用户（root）的凭据：提示同 Linux su 的「Password:」；「[sudo] password for <自己>:」只给 sudo（割接） */
      proofOf(t('pwPrompt'), 'su-challenge', function (proof) {
        C.setMode('busy');
        api.post('su', Object.assign({ user: 'root' }, proof)).then(function (r) {
          if (r.j && r.j.ok) { setUser(r.j.user); C.ok(t('rootOn'), t('rootLimit')); C.toCmd(); return; }
          fail(r, 'su root'); C.toCmd();
        }, net);
      });
      return;
    }
    if (!USER_NAME_RE.test(target)) { C.out(esc(t('usageSu'))); return; }
    if (me()) { C.err(t('exitFirst', { u: me().name })); return; }
    proofOf(t('pwPrompt'), 'su-challenge', function (proof) {
      const send = function (/** @type {string} */ np) {
        C.setMode('busy');
        api.post('su', Object.assign({ user: target }, proof, np ? { newPassword: np } : {})).then(function (r) {
          if (r.j && r.j.ok) { setUser(r.j.user); C.ok(t('signedIn', { u: r.j.user.name })); C.toCmd(); return; }
          if (r.j && r.j.error === 'must-change') { C.note(t('mustChange')); newPassword(send); return; }
          fail(r, 'su'); C.toCmd();
        }, net);
      };
      send('');
    });
  };

  /* ---------- rescue（P3，定稿 v5.2 §九） ---------- */
  /** 访客输恢复钥匙（不回显）→ 15 分钟一次性 root 救援会话；成功后提示去 Cloudflare 换新值。已登录先 exit（同 su） */
  C.cmdRescue = function () {
    if (me()) { C.err(t('exitFirst', { u: me().name })); return; }
    C.ask('pw', function (/** @type {string} */ key) {
      C.setMode('busy');
      api.post('rescue', { key: key }).then(function (r) {
        if (r.j && r.j.ok) { setUser(r.j.user); C.ok(t('rootOn'), t('rescueLimit')); C.note(t('rescueRotate')); C.toCmd(); return; }
        fail(r, 'rescue'); C.toCmd();
      }, net);
    }, { ps: t('rescueKey'), hint: t('hidden') });
  };

  /* ---------- exit / idle / lock ---------- */
  /** exit：弹一层。回 true = 有 v6 会话、由这里处理了 */
  C.cmdExit = function () {
    if (!me()) return false;
    C.setMode('busy');
    api.post('exit').then(function (r) {
      const u = r.j && r.j.ok ? r.j.user : undefined;
      if (u === undefined) { fail(r, 'exit'); C.toCmd(); return; }
      setUser(u);
      C.ok(u ? t('back', { u: u.name }) : t('signedOut'));
      C.toCmd();
    }, net);
    return true;
  };
  /** lock：清空整个栈 @param {() => void} [after] 之后再跑旧的 lock（有旧进站会话时） */
  C.cmdLock = function (after) {
    C.setMode('busy');
    api.post('lock').then(function () {
      setUser(null);
      C.ok(t('locked'));
      C.toCmd();
      if (after) after();
    }, net);
  };

  /* ---------- whoami / groups / who ---------- */
  C.cmdWhoami = function () {
    const u = me();
    C.out(esc(u ? (u.root ? 'root' : u.name) : 'nobody'));
    if (u && u.via) C.note(t('via', { p: u.path }));
  };
  /** @param {string} [user] */
  C.cmdGroups = function (user) {
    if (!me()) { C.err(t('notSignedIn')); return; }
    C.setMode('busy');
    api.post('groups', user ? { user: user } : {}).then(function (r) {
      if (r.j && r.j.ok) C.out(esc((r.j.name || '') + ' : ' + (r.j.groups || []).join(' ')));
      else fail(r, 'groups');
      C.toCmd();
    }, net);
  };
  /** @param {any[]} list */
  function printWho(list) {
    (list || []).forEach(function (s) {
      C.out(esc(s.path + '  ' + new Date(s.since).toISOString().slice(0, 16).replace('T', ' ')) + (s.current ? ' <span class="sgx-at-dim">· ' + esc(t('current')) + '</span>' : ''));
    });
  }
  C.cmdWho = function () {
    if (!me()) { C.err(t('notSignedIn')); return; }
    C.setMode('busy');
    api.post('who').then(function (r) {
      if (r.j && r.j.ok) printWho(r.j.sessions); else fail(r, 'who');
      C.toCmd();
    }, net);
  };

  /* ---------- 用户管理（root 直接跑；sudoers 走 sudo） ---------- */
  /** 命令的结果 → 输出 @param {string} action @param {any} j */
  function adminOk(action, j) {
    if (action === 'useradd') { C.ok(t('created', { u: j.user.name })); C.out(esc(t('otp', { p: j.password }))); C.note(t('otpNote')); return; }
    if (action === 'passwd-user') { C.ok(t('reset')); C.out(esc(t('otp', { p: j.password }))); C.note(t('otpNote')); return; }
    if (action === 'userdel') { C.ok(t('deleted')); return; }
    if (action === 'usermod') { C.ok(j.changed ? t('changed') : t('noChange')); if (j.warning) C.warn(t('lastWarn')); return; }
    if (action === 'groups') { C.out(esc((j.name || '') + ' : ' + (j.groups || []).join(' '))); return; }
    if (action === 'who') printWho(j.sessions);
  }
  /**
   * 跑一条管理命令：root 直接发；proof 给了就是 sudo。usermod 碰到 last-member 先问 [y/N]。
   * @param {any} cmd 服务端 command 对象 @param {any} [proof] @param {string} label 终端里的命令字
   */
  function runAdmin(cmd, proof, label) {
    C.setMode('busy');
    const call = proof ? api.post('sudo', Object.assign({ command: cmd }, proof)) : api.post(cmd.action, cmd);
    call.then(function (r) {
      if (r.j && r.j.ok) { adminOk(cmd.action, r.j); C.toCmd(); return; }
      if (r.j && r.j.error === 'last-member') {
        C.warn(t('lastMember', { g: r.j.group || '' }));
        C.opts([['y', t('yes')], ['N', t('no'), true]]);
        C.pick({
          y: function () { C.echoPick('y'); if (proof) { C.note(t('againSudo')); C.toCmd(); return; } runAdmin(Object.assign({}, cmd, { force: true }), null, label); },
          N: function () { C.echoPick('N'); C.toCmd(); },
        }, 'N');
        return;
      }
      fail(r, label); C.toCmd();
    }, net);
  }
  /** root（v6）直接跑；不是 root → 提示用 sudo @param {any} cmd @param {string} label */
  C.cmdAdmin = function (cmd, label) {
    const u = me();
    if (!u) { C.err(t('notSignedIn')); return; }
    if (!u.root) { C.err(t('permission', { c: label.split(' ')[0] })); if (u.sudoers) C.note(t('trySudo'), 'sudo ' + label); return; }
    runAdmin(cmd, null, label);
  };
  /** sudo <命令…> @param {string[]} argv */
  C.cmdSudo = function (argv) {
    const u = me();
    if (!u) { C.err(t('notSignedIn')); return; }
    /* sudo passkey …：借 root 动 root 的通行密钥，一律拒（定稿 §十；服务端同样回 root-creds），提示同 sudo passwd */
    if (argv[0] === 'passkey') { C.err(t('rootCreds')); return; }
    const cmd = sudoCommand(argv);
    if (!cmd) { C.out(esc(t('usageSudo'))); return; }
    if (cmd.action === 'passwd') { C.err(t('rootCreds')); return; }
    if (u.root) { runAdmin(cmd, null, argv.join(' ')); return; }
    if (!u.sudoers) { C.err(t('notSudoers', { u: u.name })); return; }
    proofOf(t('pwFor', { u: u.name }), 'sudo-challenge', function (proof) { runAdmin(cmd, proof, argv.join(' ')); });
  };

  /**
   * sudo 借 root 跑一条账号命令（sudo device … / sudo sub …；定稿 v5.5 §四、§七）：root 不用 sudo → done(null)；
   * 不是 sudoers → 一行红字；否则先验自己的凭据（同 sudo <命令> 的「[sudo] password for <自己>:」），done(via)：
   * via() 每次回一份证明（密码这一条命令里沿用同一个；通行密钥第一次用刚拿到的，之后每次重新验，challenge 一次一用）。
   * @param {(via: null | (() => Promise<any>)) => void} done
   */
  C.sudoProof = function (done) {
    const u = me();
    if (!u) { C.err(t('notSignedIn')); return; }
    if (u.root) { done(null); return; }
    if (!u.sudoers) { C.err(t('notSudoers', { u: u.name })); return; }
    proofOf(t('pwFor', { u: u.name }), 'sudo-challenge', function (proof) {
      let first = proof;
      done(function () {
        if (proof && typeof proof.password === 'string') return Promise.resolve({ password: proof.password });
        if (first) { const p = first; first = null; return Promise.resolve(p); }
        return api.passkeyProof('sudo-challenge');
      });
    });
  };

  /* ---------- passwd ---------- */
  /** passwd（自己）/ passwd <名>（root） @param {string} [name] */
  C.cmdPasswd = function (name) {
    const u = me();
    if (!u) { C.err(t('notSignedIn')); return; }
    if (name && name !== (u.root ? 'root' : u.name)) { C.cmdAdmin({ action: 'passwd-user', name: name }, 'passwd ' + name); return; }
    const send = function (/** @type {string} */ cur) {
      newPassword(function (np) {
        C.setMode('busy');
        api.post('passwd', u.rescue ? { password: np, as: u.uid } : { current: cur, password: np, as: u.uid }).then(function (r) {
          if (r.j && r.j.ok) { C.ok(t('passwdDone')); C.toCmd(); return; }
          fail(r, 'passwd'); C.toCmd();
        }, net);
      });
    };
    if (u.rescue) { send(''); return; }
    C.ask('pw', send, { ps: t('currentPw'), hint: t('hidden') });
  };

  /* ---------- 前台空闲（root 层） ---------- */
  let timer = 0;
  const clock = createIdleClock({
    idleMs: ROOT_IDLE_MS,
    visible: function () { return doc.visibilityState !== 'hidden'; },
    onIdle: function () {
      api.post('idle').then(function (r) {
        if (r.j && r.j.ok && r.j.popped) { setUser(r.j.user); C.note(t('idleBack', { u: r.j.user ? r.j.user.name : '' })); }
      }, function () {});
    },
  });
  ['keydown', 'pointerdown', 'touchstart', 'wheel'].forEach(function (ev) { doc.addEventListener(ev, function () { clock.activity(); }, { passive: true, capture: true }); });
  doc.addEventListener('visibilitychange', function () { if (doc.visibilityState === 'visible') armIdle(); });
  /** 只有 su root（有 via）的 root 层才计时 */
  function armIdle() {
    const u = me();
    const on = !!(u && u.root && u.via);
    if (on && !timer) { clock.reset(); timer = window.setInterval(function () { clock.tick(IDLE_TICK_MS); }, IDLE_TICK_MS); }
    if (!on && timer) { window.clearInterval(timer); timer = 0; }
  }
  if (who.on) who.on(armIdle);
  armIdle();

  return C;
}
