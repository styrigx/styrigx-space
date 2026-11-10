/**
 * @fileoverview 代理订阅的 sub-* 命令（P2，设计稿 v1.10 §8.1）：在账号终端（tty5）里做完——reauth、y/N、遮挡输入、选文件、复制都在原地。
 * 站内终端（tty2）、盾牌（tty3）、AI（tty4）里打的 sub-* 由 topbar-panel 转到这里（同 sudo root：切到账号窗口，不跳页）。
 * 后端：POST /api/account/proxy（api.proxy）；鉴权在服务端，key / link 要 reauth 票。服务端只回状态，不回链接和节点内容。
 */
import { CMD } from './commands.js';

/** 10 条命令（顺序 = 补全 / man 顺序） */
export const SUB_CMDS = Object.freeze(['sub', 'sub-key', 'sub-link', 'sub-add', 'sub-upload', 'sub-mv', 'sub-on', 'sub-off', 'sub-rm', 'sub-refresh']);
/** 来源名（同服务端 NAME_RE）：它就是下载路径的最后一段，大小写敏感 */
export const NAME_RE = /^[A-Za-z0-9_-]{1,32}$/;
/** age X25519 公钥（bech32，age1 + 58 位） */
export const AGE_RE = /^age1[02-9ac-hj-np-z]{58}$/;
/** 上传文件上限（同服务端 MAX_BYTES） */
export const MAX_FILE = 2 * 1024 * 1024;

/**
 * 原样的一行（来源名大小写敏感，不能走 normCmd）→ { cmd, args }；不是 sub 命令 → null
 * @param {string} raw @returns {{cmd: string, args: string[]} | null}
 */
export function parseSub(raw) {
  const parts = String(raw || '').trim().split(/\s+/);
  const c = (parts[0] || '').toLowerCase();
  return SUB_CMDS.indexOf(c) >= 0 ? { cmd: c, args: parts.slice(1).filter(Boolean) } : null;
}

/** 每条命令要几个名字参数 */
const ARITY = /** @type {Record<string, number>} */ ({ 'sub-add': 1, 'sub-upload': 1, 'sub-on': 1, 'sub-off': 1, 'sub-rm': 1, 'sub-mv': 2 });
/** 用法行 */
export const USAGE = /** @type {Record<string, string>} */ ({ 'sub-add': 'sub-add <name>', 'sub-upload': 'sub-upload <name>', 'sub-on': 'sub-on <name>', 'sub-off': 'sub-off <name>', 'sub-rm': 'sub-rm <name>', 'sub-mv': 'sub-mv <old> <new>' });

/** @param {any} C */
export function mountProxy(C) {
  const t = C.t;
  const tf = C.tf;
  const esc = C.esc;
  const api = C.api;
  const P = api.proxy;
  /** sub-link 刚印出的地址（复制按钮按序号取；关下拉就清） @type {string[]} */
  let urls = [];

  /** 错误类别 → 文案（没有就交给通用的） @param {any} res */
  function errOut(res) {
    const code = res && res.j && res.j.error;
    const k = 'proxy.err.' + code;
    if (code && t(k)) { C.err(t(k)); return; }
    C.apiErr(res);
  }
  /** 一行：灰色的 # 注释 @param {string} s */
  const dim = function (s) { C.out('# ' + esc(s), 'd'); };
  /** 名字参数检查；不合格就报错回 false @param {string} cmd @param {string[]} args */
  function argsOk(cmd, args) {
    const n = ARITY[cmd] || 0;
    if (args.length !== n) { C.err(tf('proxy.usage', { x: USAGE[cmd] || cmd })); return false; }
    for (const a of args) if (!NAME_RE.test(a)) { C.err(t('proxy.badName')); return false; }
    return true;
  }
  /**
   * 发请求：busy → 成功 ok(j) → 回命令行；reauth 票过期 → 重新 reauth 再来；没会话 → authErr；其余报错类别
   * @param {() => Promise<any>} req @param {(j: any) => void} ok @param {() => void} [again] reauth 过期时重做
   */
  function call(req, ok, again) {
    C.setMode('busy');
    req().then(function (/** @type {any} */ res) {
      if (res.j && res.j.ok) { ok(res.j); C.toCmd(); return; }
      if (again && api.isErr(res, api.ERR.reauth)) { C.reauthExp = 0; C.toCmd(); C.withReauth(again, ''); return; }
      if (C.authErr(res)) { C.toCmd(); return; }
      if (res.j && res.j.kept) C.err(tf('proxy.kept', { e: t('proxy.err.' + res.j.error) || res.j.error }));
      else errOut(res);
      C.toCmd();
    }, function () { C.netErr(); C.toCmd(); });
  }
  /** 改动后的自动刷新结果（服务端 await 完才回） @param {any} r */
  function printRefresh(r) {
    if (!r) return;
    if (!r.ok) { C.err(t('proxy.err.' + r.error) || r.error); return; }
    for (const s of r.sources || []) {
      if (s.ok) C.out('<span class="sgx-at-ok">✓</span> ' + esc(s.name) + ' <span class="sgx-at-dim">· ' + esc(tf('proxy.nodes', { n: s.nodes })) + '</span>');
      else C.out('✗ ' + esc(s.name) + ' <span class="sgx-at-dim">· ' + esc(t('proxy.err.' + s.error) || s.error) + (s.nodes ? ' · ' + esc(t('proxy.stale')) : '') + '</span>', 'warn');
    }
  }
  /** y/N（回车 = N） @param {string} ask @param {() => void} yes */
  function askYN(ask, yes) {
    C.out('<span class="sgx-at-w">' + esc(ask) + '</span>');
    C.opts([['y', t('proxy.yes')], ['n', t('proxy.no')]]);
    C.pick({
      y: function () { C.echoPick('y'); yes(); },
      n: function () { C.echoPick('n'); dim(t('proxy.cancelled')); C.toCmd(); },
    }, 'n');
    C.focusIn();
  }
  /** 先拿状态再做 @param {(s: any) => void} fn */
  function withStatus(fn) {
    C.setMode('busy');
    P.status().then(function (/** @type {any} */ res) {
      if (!(res.j && res.j.ok)) { if (!C.authErr(res)) errOut(res); C.toCmd(); return; }
      C.toCmd();
      fn(res.j);
    }, function () { C.netErr(); C.toCmd(); });
  }
  /** @param {any} s @param {string} name */
  const find = function (s, name) { return (s.sources || []).find(function (/** @type {any} */ x) { return x.name === name; }); };

  /** sub：状态 @param {any} s */
  function printStatus(s) {
    C.out('<span class="sgx-at-dim">' + esc(t('proxy.key')) + '</span> ' + (s.hasKey ? '<span translate="no">' + esc(s.pubkey) + '</span>' : esc(tf('proxy.keyUnset', { x: '' })) + C.k('sub-key')));
    C.out('<span class="sgx-at-dim">' + esc(t('proxy.link')) + '</span> ' + (s.hasLink ? esc(t('proxy.linkYes')) : esc(tf('proxy.linkNo', { x: '' })) + C.k('sub-link')));
    if (s.refreshing) C.out(esc(t('proxy.refreshing')), 'warn');
    const list = s.sources || [];
    if (!list.length) { C.out('# ' + esc(tf('proxy.none', { x: '' })).replace(/^\s+/, '') + C.k('sub-add <name>'), 'd'); return; }
    for (const x of list) {
      const where = x.type === 'airport' ? x.host : t('proxy.file');
      const state = !x.enabled ? t('proxy.off') : x.error ? (t('proxy.err.' + x.error) || x.error) : t('proxy.on');
      C.out('<span class="sgx-at-w" translate="no">' + esc(x.name) + '</span> <span class="sgx-at-dim">· ' + esc(where) + ' · ' + esc(tf('proxy.nodes', { n: x.nodes })) + ' ·</span> ' +
        (x.error && x.enabled ? '<span class="sgx-at-y">' + esc(state) + '</span>' : esc(state)));
    }
  }

  /** sub-key：粘贴公钥 → reauth → 保存（自动重加密） */
  function cmdKey() {
    const go = function () {
      C.ask('pkname', function (/** @type {string} */ v) {
        const k = v.trim();
        if (k.indexOf('age1pq1') === 0) { C.err(t('proxy.err.pq-unsupported')); C.toCmd(); return; }
        if (!AGE_RE.test(k)) { C.err(t('proxy.err.pubkey')); C.toCmd(); return; }
        const send = function () {
          call(function () { return P.key(k); }, function (j) { C.ok('✓ ' + tf('proxy.keySaved', { k: j.pubkey || '' })); printRefresh(j.refresh); }, send);
        };
        send();
      }, { ps: t('proxy.keyPs'), hint: t('proxy.keyHint'), aria: t('proxy.keyPs') });
    };
    C.withReauth(go, t('proxy.lead.key'));
  }

  /** sub-link：没有就生成，有就问替换；印出令牌和每个来源的完整地址（各带复制），只这一次 */
  function cmdLink() {
    withStatus(function (s) {
      const make = function () {
        const send = function () {
          call(function () { return P.link(); }, function (j) {
            const base = String(j.base || '') + String(j.token || '') + '/';
            urls = [String(j.token || '')];
            C.out('<span class="sgx-at-y">' + esc(t('proxy.linkOnce')) + '</span>', 'warn');
            C.out('<span class="sgx-at-dim">' + esc(t('proxy.linkToken')) + '</span> <span translate="no" data-sgx-personal>' + esc(urls[0]) + '</span> ' + copyBtn(0));
            const list = s.sources || [];
            if (!list.length) { dim(t('proxy.linkNoSrc')); C.out('<span translate="no" data-sgx-personal>' + esc(base) + '</span>'); return; }
            for (const x of list) {
              urls.push(base + x.name);
              C.out('<span translate="no" data-sgx-personal>' + esc(base + x.name) + '</span> ' + copyBtn(urls.length - 1));
            }
          }, send);
        };
        C.withReauth(send, t('proxy.lead.link'));
      };
      if (!s.hasLink) { make(); return; }
      C.out(esc(tf('proxy.linkReplace', { n: (s.sources || []).length })), 'warn');
      askYN(t('proxy.linkAsk'), make);
    });
  }
  /** @param {number} i */
  const copyBtn = function (i) { return '<button type="button" class="sgx-at-nm" data-at-act="sub-copy:' + i + '">' + esc(t('proxy.copy')) + '</button>'; };

  /** sub-add <名称>：遮挡输入链接；同名即改链接（显示新旧域名再确认，先试拉成功才换） @param {string} name */
  function cmdAdd(name) {
    withStatus(function (s) {
      const old = find(s, name);
      if (old && old.type !== 'airport') { C.err(t('proxy.err.type')); return; }
      C.ask('suburl', function (/** @type {string} */ v) {
        const url = v.trim();
        let host = '';
        try { const u = new URL(url); if (u.protocol === 'https:' && !u.username && !u.password) host = u.hostname; } catch (e) {}
        if (!host) { C.err(t('proxy.err.url')); C.toCmd(); return; }
        const send = function () {
          dim(t('proxy.refreshing'));
          call(function () { return P.add(name, url); }, function (j) {
            C.ok('✓ ' + (j.updated ? tf('proxy.changed', { v: name, a: j.oldHost || '', b: j.host || host }) : tf('proxy.added', { v: name, h: j.host || host })));
            printRefresh(j.refresh);
          });
        };
        if (old) { C.toCmd(); askYN(tf('proxy.addAsk', { v: name, a: old.host || '', b: host }), send); return; }
        send();
      }, { ps: t('proxy.urlPs'), hint: t('proxy.urlHint'), aria: t('proxy.urlPs') });
    });
  }

  /** sub-upload <名称>：系统文件选择 → 读文本 → 字符进度条 → 上传（同名即覆盖） @param {string} name */
  function cmdUpload(name) {
    const fi = C.doc.createElement('input');
    fi.type = 'file';
    fi.accept = '.yaml,.yml,.txt,text/yaml,application/yaml,text/plain';
    fi.hidden = true;
    C.root.appendChild(fi);
    let done = false;
    const end = function () { done = true; try { fi.remove(); } catch (e) {} };
    C.setMode('busy', { cc: true, hint: t('proxy.picking') });
    C.busyCancel = function () { end(); };
    fi.addEventListener('change', function () {
      if (done) return;
      const f = fi.files && fi.files[0];
      end();
      if (!f) { C.toCmd(); return; }
      if (f.size > MAX_FILE) { C.err(t('proxy.err.size')); C.toCmd(); return; }
      const bar = function (/** @type {number} */ pct) {
        const n = Math.round(pct / 5);
        return '[' + '#'.repeat(n) + '.'.repeat(20 - n) + '] ' + pct + '%';
      };
      C.out('<span translate="no">' + esc(f.name) + '</span>', 'd');
      const line = C.out('<span translate="no">' + bar(0) + '</span>', 'd');
      const paint = function (/** @type {number} */ pct) { if (line && line.firstChild) line.firstChild.textContent = bar(pct); };
      const rd = new FileReader();
      rd.onprogress = function (e) { if (e.lengthComputable) paint(Math.min(50, Math.round(e.loaded / e.total * 50))); };
      rd.onerror = function () { C.err(t('proxy.err.format')); C.toCmd(); };
      rd.onload = function () {
        paint(50);
        call(function () { return P.upload(name, String(rd.result || '')); }, function (j) {
          paint(100);
          C.ok('✓ ' + tf('proxy.uploaded', { v: name, n: j.nodes || 0 }));
          printRefresh(j.refresh);
        });
      };
      rd.readAsText(f);
    });
    /* 用户取消了系统的选择窗口：有的浏览器发 cancel，有的什么都不发（^C / esc 照样能退） */
    fi.addEventListener('cancel', function () { if (!done) { end(); dim(t('proxy.cancelled')); C.toCmd(); } });
    dim(t('proxy.pick'));
    fi.click();
  }

  /** sub-mv <旧名> <新名>：只改名，不刷新；确认时显示新旧路径（令牌遮挡） @param {string} a @param {string} b */
  function cmdMv(a, b) {
    if (a === b) { dim(tf('proxy.moved', { a: a, b: b })); return; }
    const path = function (/** @type {string} */ n) { return '/s/••••/' + n; };
    withStatus(function (s) {
      if (!find(s, a)) { C.err(tf('proxy.notFound', { v: a })); return; }
      if (find(s, b)) { C.err(t('proxy.err.exists')); return; }
      askYN(tf('proxy.mvAsk', { a: path(a), b: path(b) }), function () {
        call(function () { return P.mv(a, b); }, function () { C.ok('✓ ' + tf('proxy.moved', { a: a, b: b })); });
      });
    });
  }

  /** sub-on / sub-off <名称> @param {string} name @param {boolean} on */
  function cmdToggle(name, on) {
    dim(t('proxy.refreshing'));
    call(function () { return P.toggle(name, on); }, function (j) {
      C.ok('✓ ' + tf('proxy.switched', { v: name, s: t(on ? 'proxy.on' : 'proxy.off') }));
      printRefresh(j.refresh);
    });
  }

  /** sub-rm <名称>（y/N） @param {string} name */
  function cmdRm(name) {
    withStatus(function (s) {
      if (!find(s, name)) { C.err(tf('proxy.notFound', { v: name })); return; }
      askYN(tf('proxy.rmAsk', { v: name }), function () {
        call(function () { return P.rm(name); }, function (j) { C.ok('✓ ' + tf('proxy.removed', { v: name })); printRefresh(j.refresh); });
      });
    });
  }

  /**
   * 跑一条 sub 命令（runCmd 已回显）。没登录：先 sudo root。
   * @param {string} raw 原样的一行
   */
  C.cmdSub = function (raw) {
    const p = parseSub(raw);
    if (!p) return;
    if (C.st !== 'in' || C.inReset) { C.err(t('session.notSignedIn'), CMD.session); return; }
    if (p.cmd === 'sub' || p.cmd === 'sub-key' || p.cmd === 'sub-link' || p.cmd === 'sub-refresh') {
      if (p.args.length) { C.err(tf('proxy.usage', { x: p.cmd })); return; }
    } else if (!argsOk(p.cmd, p.args)) return;
    const a = p.args;
    switch (p.cmd) {
      case 'sub': withStatus(printStatus); return;
      case 'sub-key': cmdKey(); return;
      case 'sub-link': cmdLink(); return;
      case 'sub-add': cmdAdd(a[0]); return;
      case 'sub-upload': cmdUpload(a[0]); return;
      case 'sub-mv': cmdMv(a[0], a[1]); return;
      case 'sub-on': cmdToggle(a[0], true); return;
      case 'sub-off': cmdToggle(a[0], false); return;
      case 'sub-rm': cmdRm(a[0]); return;
      default:
        dim(t('proxy.refreshing'));
        call(function () { return P.refresh(); }, function (j) { C.out(esc(t('proxy.result')), 'd'); printRefresh(j); });
    }
  };

  /** 复制按钮 @param {string} a @returns {boolean} */
  C.actProxy = function (a) {
    if (a.indexOf('sub-copy:') !== 0) return false;
    const v = urls[Number(a.slice(9))];
    if (!v) return true;
    const doneMsg = function () { C.toast(t('proxy.copied')); };
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) { navigator.clipboard.writeText(v).then(doneMsg, function () {}); return true; }
    } catch (e) {}
    return true;
  };
  /** 关下拉：印过的地址不留在内存里 */
  C.forgetProxy = function () { urls = []; };
}
