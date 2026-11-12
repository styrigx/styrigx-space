/**
 * @fileoverview 自己的通行密钥的终端命令（v6，定稿 v5.2 §八「普通用户用 passwd、passkey 改自己的凭据；通行密钥自带 WebAuthn 验证」；
 * v6-commands「自己的账号」passkey ls / add / rm <n>；§九 救援白名单含 passkey）。
 *
 * - passkey [ls]：列表（[n] 名字 · 保存在哪 · 创建日期 · 上次使用）· passkey add：系统窗口 → 注册（带预填名，不再问名字）· passkey rm <n>：[y/N]
 * 后端 POST /api/identity passkey-*（user 档，按服务端会话 uid 管栈顶那个用户自己的；api.v6keys）；401 / 403 走 C.authErr（./auth-err.js）。
 * v6 P4 起旧的账号钥匙（sudo root reauth / reset 票、/api/account/keys、账号 passwd）删除；改密码是身份层的 passwd。
 */
import { registerPasskey, genPkPrefillName } from '../../../auth/passkey-register.js';

/** MM-DD @param {number} ts */
export function mmdd(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  const p = function (/** @type {number} */ n) { return (n < 10 ? '0' : '') + n; };
  return p(d.getMonth() + 1) + '-' + p(d.getDate());
}

/** @param {any} C 账号层上下文（./layer.js） */
export function mountKeys(C) {
  const t = C.t;
  const tf = C.tf;
  const esc = C.esc;
  const api = C.api;
  /** 最近一次列出的通行密钥（rm <n> 的编号对着它） @type {any[]} */
  C.keyList = [];
  /** @param {string} id */
  function provLabel(id) { return id && /^[a-z0-9-]+$/.test(id) ? t('keys.passkey.provider.' + id.replace(/-/g, '_')) : ''; }
  /** @param {any} key */
  function keyName(key) { return key.name || provLabel(key.provider) || t('keys.passkey.unnamed'); }

  /** 取列表（不打印） @param {(ok: boolean) => void} [then]*/
  C.loadKeys = function (then) {
    C.setMode('busy');
    return api.v6keys.passkeyList(C.asUid()).then(function (/** @type {any} */ res) {
      C.toCmd();
      if (res.j && res.j.ok) {
        C.keyList = res.j.keys || [];
        if (then) then(true);
        return;
      }
      if (!C.authErr(res)) C.apiErr(res);
      if (then) then(false);
    }, function () { C.netErr(); C.toCmd(); if (then) then(false); });
  };

  /** passkey：列出*/
  C.passkeyList = function () {
    C.loadKeys(function (ok) {
      if (!ok) return;
      if (!C.keyList.length) { C.note('keys.passkey.none'); return; }
      C.keyList.forEach(function (/** @type {any} */ key, /** @type {number} */ i) {
        const sub = [provLabel(key.provider), tf('keys.passkey.created', { d: mmdd(key.createdAt) }), key.lastUsedAt ? tf('keys.passkey.lastUsed', { d: mmdd(key.lastUsedAt) }) : t('keys.passkey.neverUsed')].filter(Boolean).join(' · ');
        C.out('<span class="sgx-at-p">[' + (i + 1) + ']</span> <span translate="no" data-sgx-personal>' + esc(keyName(key)) + '</span> <span class="sgx-at-dim">· ' + esc(sub) + '</span>');
      });
    });
  };

  /** passkey add：系统窗口 → 注册（v6 没有改名接口，带预填名、不问名字） @param {boolean} [typed]*/
  C.cmdPasskeyAdd = function (typed) {
    if (!typed) C.echo('passkey add');
    C.setMode('busy', { cc: true });
    const toRes = function (/** @type {any} */ r) { return { status: r.s, json: r.j }; };
    /* passkey-add 要带回 challenge 里的 user.id（服务端用它对上这次 challenge） */
    let handle = '';
    const x = {
      passkeyAddChallenge: function () {
        return api.v6keys.passkeyAddChallenge(C.asUid()).then(function (/** @type {any} */ r) { handle = (r && r.j && r.j.user && r.j.user.id) || ''; return r; });
      },
      passkeyAdd: function (/** @type {any} */ body) { return api.v6keys.passkeyAdd(body, handle, C.asUid()); },
    };
    let done = false;
    /* 等系统窗口时可 ^C / esc / 点 ^C（2026-11-09）：收起系统窗口（AbortController），之后回来的结果不再提示、不再提交注册 */
    let stopped = false;
    const ac = typeof AbortController === 'function' ? new AbortController() : null;
    C.busyCancel = function () { stopped = true; try { if (ac) ac.abort(); } catch (e) {} };
    registerPasskey({
      stale: function () { return stopped; },
      signal: ac ? ac.signal : undefined,
      challenge: function () { return x.passkeyAddChallenge().then(toRes); },
      register: function (/** @type {any} */ body) { return x.passkeyAdd(body).then(toRes); },
      onAuthError: function (/** @type {any} */ res) { return C.authErr({ s: res.status, j: res.json }); },
      onRegistered: function () {
        done = true;
        C.busyCancel = null;
        C.keyList = [];
        /* ^C 时注册请求已经发出去了：钥匙已存上，不再接着问名字 */
        if (stopped) return;
        C.ok('✓ ' + t('keys.passkey.registered'));
        C.toCmd();
      },
      prefill: function () { return genPkPrefillName(''); },
      errText: function (/** @type {string} */ c, /** @type {number} */ s) { return api.errText(C.errT, c, s); },
      toast: function (/** @type {string} */ m) { if (!stopped) C.err(m); },
      msg: { cancelled: t('common.cancelled'), already: t('keys.passkey.already'), noSupport: t('common.pkNoSupport'), failed: t('keys.passkey.failed'), network: t('common.errNetwork') },
    }).then(function () { if (!done && !stopped && C.mode === 'busy') C.toCmd(); });
  };
  /** passkey rm <n>：编号对着现在的列表（先取一次），[y/N] @param {number} n*/
  C.passkeyRm = function (n) {
    C.loadKeys(function (ok) {
      if (!ok) return;
      const key = C.keyList[n - 1];
      if (!key) { C.err(t('keys.passkey.noSuch')); C.note('keys.passkey.lsFirst', 'passkey'); return; }
      C.out(esc(tf('keys.passkey.rmAsk', { n: keyName(key) })) + ' [y/N]');
      C.pick({
        y: function () {
          C.echoPick('y');
          C.setMode('busy');
          api.v6keys.passkeyDelete(key.n || n, C.asUid()).then(function (/** @type {any} */ res) {
            if (res.j && res.j.ok) {
              C.out('<span class="sgx-at-ok">✓</span> ' + esc(t('keys.passkey.deleted')));
              C.keyList = [];
              C.toCmd();
              return;
            }
            if (C.authErr(res)) { C.toCmd(); return; }
            C.apiErr(res);
            C.toCmd();
          }, function () { C.netErr(); C.toCmd(); });
        },
        n: function () { C.echoPick('n'); C.toCmd(); },
      }, 'n', { ps: '[y/N]' });
    });
  };
}
