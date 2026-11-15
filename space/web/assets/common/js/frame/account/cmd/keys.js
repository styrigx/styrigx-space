/**
 * @fileoverview 自己的通行密钥的终端命令（v6，定稿 v5.2 §八「普通用户用 passwd、passkey 改自己的凭据；通行密钥自带 WebAuthn 验证」；
 * v6-commands「自己的账号」passkey ls / add / rm <n>；§九 救援白名单含 passkey）。
 *
 * - passkey [ls]：列表（[n] 名字 · 保存在哪 · 创建日期 · 上次使用）· passkey add：系统窗口 → 注册（带预填名，不再问名字）· passkey rm <n>：[y/N]
 * 后端 POST /api/identity passkey-*（user 档，按服务端会话 uid 管栈顶那个用户自己的；api.v6keys）；401 / 403 走 C.authErr（./auth-err.js）。
 * R-34（稿 v3.11 第 8 节）：add、rm 先验证（密码或任一把通行密钥，身份层 selfProof 问；救援会话免）——add 用通行密钥验证会弹两次
 * （先刷已有钥匙、再建新钥匙），接受；rm 允许删最后一把、允许用待删的那把验证，删最后一把时提示一句。
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

/**
 * 身份层给的「自己改凭据先验证」（identity/layer.js selfProof / selfFail；R-34）
 * @typedef {{ prove: (next: (proof: any) => void) => void, fail: (res: {s:number, j:any}, cmd: string) => void }} SelfProof
 */

/**
 * 验证没过（401 auth / 429 cooldown）→ 用身份层现成的「认证失败」「尝试太多次」（不新造文案），回 true；别的回 false。
 * @param {SelfProof|null|undefined} self @param {{s:number, j:any}} res
 */
export function proofFailed(self, res) {
  const e = res && res.j ? res.j.error : '';
  if (!self || !((res.s === 401 && e === 'auth') || (res.s === 429 && e === 'cooldown'))) return false;
  self.fail(res, 'passkey');
  return true;
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

  /**
   * passkey add：先验证（prove），再系统窗口 → 注册（v6 没有改名接口，带预填名、不问名字）
   * @param {boolean} [typed] @param {SelfProof} [self] 身份层的验证（没给 → 不带证明，服务端会拒）
   */
  C.cmdPasskeyAdd = function (typed, self) {
    if (!typed) C.echo('passkey add');
    if (self) { self.prove(function (proof) { addWith(proof, self); }); return; }
    addWith(null, null);
  };
  /** @param {any} proof @param {SelfProof|null} self */
  function addWith(proof, self) {
    C.setMode('busy', { cc: true });
    const toRes = function (/** @type {any} */ r) { return { status: r.s, json: r.j }; };
    /* passkey-add 要带回 challenge 里的 user.id（服务端用它对上这次 challenge） */
    let handle = '';
    const x = {
      passkeyAddChallenge: function () {
        return api.v6keys.passkeyAddChallenge(C.asUid()).then(function (/** @type {any} */ r) { handle = (r && r.j && r.j.user && r.j.user.id) || ''; return r; });
      },
      passkeyAdd: function (/** @type {any} */ body) { return api.v6keys.passkeyAdd(body, handle, C.asUid(), proof); },
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
      onAuthError: function (/** @type {any} */ res) { return proofFailed(self, { s: res.status, j: res.json }) || C.authErr({ s: res.status, j: res.json }); },
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
  }
  /**
   * passkey rm <n>：编号对着现在的列表（先取一次），[y/N]，选 y 后先验证（prove）再删
   * @param {number} n @param {SelfProof} [self] 身份层的验证
   */
  C.passkeyRm = function (n, self) {
    C.loadKeys(function (ok) {
      if (!ok) return;
      const key = C.keyList[n - 1];
      if (!key) { C.err(t('keys.passkey.noSuch')); C.note('keys.passkey.lsFirst', 'passkey'); return; }
      C.out(esc(tf('keys.passkey.rmAsk', { n: keyName(key) })) + ' [y/N]');
      C.pick({
        y: function () {
          C.echoPick('y');
          const lastOne = C.keyList.length === 1;
          const go = function (/** @type {any} */ proof) {
            C.setMode('busy');
            api.v6keys.passkeyDelete(key.n || n, C.asUid(), proof).then(function (/** @type {any} */ res) {
              if (res.j && res.j.ok) {
                C.out('<span class="sgx-at-ok">✓</span> ' + esc(t('keys.passkey.deleted')));
                if (lastOne) C.note('keys.passkey.lastGone');
                C.keyList = [];
                C.toCmd();
                return;
              }
              if (proofFailed(self, res) || C.authErr(res)) { C.toCmd(); return; }
              C.apiErr(res);
              C.toCmd();
            }, function () { C.netErr(); C.toCmd(); });
          };
          if (self) self.prove(go); else go(null);
        },
        n: function () { C.echoPick('n'); C.toCmd(); },
      }, 'n', { ps: '[y/N]' });
    });
  };
}
