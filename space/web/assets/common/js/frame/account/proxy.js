/**
 * @fileoverview 代理订阅的 sub 指令（v3.1，Gray 2026-11-10 定；v1.13 加 map / fp / update，enable|disable 改回 on|off）：一条 `sub` + 子命令，在终端里原地做完——y/N、遮挡输入、选文件、复制。
 * 终端命令表里的 sub（term/cmds/sub/index.js）把原样的一行交给这里（C.cmdSub）。
 * 后端：POST /api/account/proxy（api.proxy）；鉴权在服务端（root 档；v6 P4 起没有旧会话的 reauth 票）。令牌由服务端封存，sub show 随时重印。
 */
import { SUB_ARGS, rememberSources } from '../term/cmds/sub/args.js';

export { SUB_ARGS };
/** 来源名（同服务端 NAME_RE）：它就是下载路径的最后一段，大小写敏感 */
export const NAME_RE = /^[A-Za-z0-9_-]{1,32}$/;
/** age X25519 公钥（bech32，age1 + 58 位） */
export const AGE_RE = /^age1[02-9ac-hj-np-z]{58}$/;
/** 上传文件上限（同服务端 MAX_BYTES） */
export const MAX_FILE = 2 * 1024 * 1024;

/** 每个子命令的名字参数个数 [最少, 最多] */
const ARITY = /** @type {Record<string, [number, number]>} */ ({ '': [0, 0], 'show': [0, 1], 'add': [1, 1], 'upload': [1, 1], 'mv': [2, 2], 'rm': [1, 1], 'on': [1, 1], 'off': [1, 1], 'update': [1, 1], 'key': [0, 0] });
/** 源词（同服务端）：去首尾空白后 1–32 字符，不能是 rm、ls（它们是 map 的子命令） */
export const WORD_MAX = 32;
/** 目标词：ISO 3166-1 两位或三位国家码（对不对照表由服务端判） */
export const CODE_RE = /^[A-Za-z]{2,3}$/;
/** 用法行 */
export const USAGE = /** @type {Record<string, string>} */ ({
  '': 'sub', 'show': 'sub show [name]', 'add': 'sub add <name>', 'upload': 'sub upload <name>', 'mv': 'sub mv <old> <new>',
  'rm': 'sub rm <name>', 'on': 'sub on <name>', 'off': 'sub off <name>', 'update': 'sub update <name>',
  'map': 'sub map [word [target]] | sub map rm <word> | sub map ls <name>', 'fp': 'sub fp [value]', 'key': 'sub key', 'token': 'sub token reset',
});

/**
 * 一行拆词：空白分隔，双引号里的空白不拆（源词可以带空格：sub map "united kingdom" GB）
 * @param {string} raw @returns {string[]}
 */
export function splitWords(raw) {
  const out = [];
  const re = /"([^"]*)"|(\S+)/g;
  let m;
  while ((m = re.exec(String(raw || ''))) !== null) out.push(m[1] !== undefined ? m[1] : m[2]);
  return out;
}

/**
 * 原样的一行（来源名大小写敏感，不能走 normCmd）→ { sub, args }；第一个词不是 sub → null。
 * 子命令不分大小写；不认识的子命令原样放进 sub（cmdSub 报用法）。
 * @param {string} raw @returns {{sub: string, args: string[]} | null}
 */
export function parseSub(raw) {
  const parts = splitWords(raw);
  if ((parts[0] || '').toLowerCase() !== 'sub') return null;
  return { sub: (parts[1] || '').toLowerCase(), args: parts.slice(2) };
}

/**
 * 参数检查（唯一一处）：子命令认识、名字个数对、每个名字合法 → null；否则回错误 { usage } 或 { badName: true }
 * @param {{sub: string, args: string[]}} p @returns {null | {usage: string} | {badName: true}}
 */
export function checkSub(p) {
  /* sub token reset（S9，同 sudo root reset 的写法）：只认这一种；单 sub token 给用法 */
  if (p.sub === 'token') return p.args.length === 1 && p.args[0].toLowerCase() === 'reset' ? null : { usage: USAGE.token };
  if (p.sub === 'map') return checkMap(p.args);
  if (p.sub === 'fp') return p.args.length <= 1 ? null : { usage: USAGE.fp };
  const n = ARITY[p.sub];
  if (!n) return { usage: SUB_ARGS.map(function (s) { return USAGE[s]; }).join(' | ') };
  if (p.args.length < n[0] || p.args.length > n[1]) return { usage: USAGE[p.sub] };
  for (const a of p.args) if (!NAME_RE.test(a)) return { badName: true };
  return null;
}

/**
 * sub map 的参数：[] 列出；rm <源词>；ls <源名>；<源词>；<源词> <目标词>
 * @param {string[]} a @returns {null | {usage: string} | {badName: true} | {badWord: true} | {badCode: true}}
 */
function checkMap(a) {
  const head = (a[0] || '').toLowerCase();
  if (head === 'rm') return a.length === 2 ? (okWord(a[1]) ? null : { badWord: true }) : { usage: USAGE.map };
  if (head === 'ls') return a.length === 2 ? (NAME_RE.test(a[1]) ? null : { badName: true }) : { usage: USAGE.map };
  if (a.length > 2) return { usage: USAGE.map };
  if (a.length && !okWord(a[0])) return { badWord: true };
  if (a.length === 2 && !CODE_RE.test(a[1])) return { badCode: true };
  return null;
}
/** @param {string} w */
const okWord = function (w) { const v = String(w || '').trim().toLowerCase(); return !!v && v.length <= WORD_MAX && v !== 'rm' && v !== 'ls'; };

/** @param {any} C */
export function mountProxy(C) {
  const t = C.t;
  const tf = C.tf;
  const esc = C.esc;
  const api = C.api;
  const P = api.proxy;
  /** sub show / sub token 刚印出的令牌和地址（复制按钮按序号取；关终端就清） @type {string[]} */
  let urls = [];
  /** 服务端说没会话 / 档不够 / 票过期 @param {any} res @returns {boolean} */
  const authErr = function (res) { return C.authErr(res); };

  /** 错误类别 → 文案（没有就交给通用的） @param {any} res */
  function errOut(res) {
    const code = res && res.j && res.j.error;
    const k = 'proxy.err.' + code;
    if (code && t(k)) { C.err(t(k)); return; }
    C.apiErr(res);
  }
  /** 一行：灰色的 # 注释 @param {string} s */
  const dim = function (s) { C.out('# ' + esc(s), 'd'); };
  /**
   * 发请求：busy → 成功 ok(j) → 回命令行；reauth 票过期 → 重新 reauth 再来；没会话 → authErr；其余报错类别
   * @param {() => Promise<any>} req @param {(j: any) => void} ok @param {() => void} [again] reauth 过期时重做
   * @param {(j: any) => boolean} [failed] 业务失败先给它，回 true 表示已经报过
   */
  function call(req, ok, again, failed) {
    C.setMode('busy');
    req().then(function (/** @type {any} */ res) {
      if (res.j && res.j.ok) { ok(res.j); C.toCmd(); return; }
      if (authErr(res)) { C.toCmd(); return; }
      if (failed && res.j && failed(res.j)) { C.toCmd(); return; }
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
      if (!(res.j && res.j.ok)) { if (!authErr(res)) errOut(res); C.toCmd(); return; }
      rememberSources(res.j.sources);
      C.toCmd();
      fn(res.j);
    }, function () { C.netErr(); C.toCmd(); });
  }
  /** @param {any} s @param {string} name */
  const find = function (s, name) { return (s.sources || []).find(function (/** @type {any} */ x) { return x.name === name; }); };

  /** 令牌状态 → [文案键, 文案里的命令] */
  const TOKEN_LINE = /** @type {Record<string, [string, string]>} */ ({ sealed: ['proxy.tokenSealed', 'sub show'], 'hash-only': ['proxy.tokenHashOnly', 'sub token reset'], none: ['proxy.tokenNone', 'sub token reset'] });

  /** sub：状态 @param {any} s */
  function printStatus(s) {
    C.out('<span class="sgx-at-dim">' + esc(t('proxy.key')) + '</span> ' + (s.hasKey ? '<span translate="no">' + esc(s.pubkey) + '</span>' : esc(tf('proxy.keyUnset', { x: '' })) + C.k('sub key')));
    const tk = TOKEN_LINE[s.token] || TOKEN_LINE.none;
    C.out('<span class="sgx-at-dim">' + esc(t('proxy.token')) + '</span> ' + esc(tf(tk[0], { x: '' })) + C.k(tk[1]));
    if (s.refreshing) C.out(esc(t('proxy.refreshing')), 'warn');
    const list = s.sources || [];
    if (!list.length) { C.out('# ' + esc(tf('proxy.none', { x: '' })).replace(/^\s+/, '') + C.k('sub add <name>'), 'd'); return; }
    for (const x of list) {
      const where = x.type === 'airport' ? x.host : t('proxy.file');
      const state = !x.enabled ? t('proxy.disabled') : x.error ? (t('proxy.err.' + x.error) || x.error) : t('proxy.enabled');
      const miss = x.type === 'airport' ? ' · ' + esc(tf('proxy.unmatched', { n: x.unmatched || 0 })) : '';
      C.out('<span class="sgx-at-w" translate="no">' + esc(x.name) + '</span> <span class="sgx-at-dim">· ' + esc(where) + ' · ' + esc(tf('proxy.nodes', { n: x.nodes })) + miss + ' ·</span> ' +
        (x.error && x.enabled ? '<span class="sgx-at-y">' + esc(state) + '</span>' : esc(state)));
    }
  }

  /** sub key：粘贴公钥 → reauth → 保存（自动重加密） */
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
    go();
  }

  /**
   * 印令牌和地址（各带复制）：name 给了只印那一个来源
   * @param {any} j 服务端回的 { token, base } @param {any[]} list 来源 @param {string} [name]
   */
  function printUrls(j, list, name) {
    const base = String(j.base || '') + String(j.token || '') + '/';
    urls = [String(j.token || '')];
    C.out('<span class="sgx-at-dim">' + esc(t('proxy.tokenLabel')) + '</span> <span translate="no" data-sgx-personal>' + esc(urls[0]) + '</span> ' + copyBtn(0));
    const show = name ? list.filter(function (/** @type {any} */ x) { return x.name === name; }) : list;
    if (!show.length) { dim(t('proxy.showNoSrc')); C.out('<span translate="no" data-sgx-personal>' + esc(base) + '</span>'); return; }
    for (const x of show) {
      urls.push(base + x.name);
      C.out('<span translate="no" data-sgx-personal>' + esc(base + x.name) + '</span> ' + copyBtn(urls.length - 1));
    }
  }

  /** sub show [名称]：服务端解封令牌 → 印地址（随时可重印） @param {string} [name] */
  function cmdShow(name) {
    withStatus(function (s) {
      if (name && !find(s, name)) { C.err(tf('proxy.notFound', { v: name })); return; }
      if (s.token !== 'sealed') { C.err(t(s.token === 'hash-only' ? 'proxy.err.token-unsealed' : 'proxy.err.no-token')); return; }
      const send = function () { call(function () { return P.show(); }, function (j) { printUrls(j, s.sources || [], name); }, send); };
      send();
    });
  }

  /** sub token reset：已有令牌先 y/N（旧链接全部失效）→ 换新 → 印新地址 */
  function cmdToken() {
    withStatus(function (s) {
      const make = function () {
        const send = function () {
          call(function () { return P.rotate(); }, function (j) {
            C.out('<span class="sgx-at-y">' + esc(tf('proxy.tokenNew', { x: 'sub show' })) + '</span>', 'warn');
            printUrls(j, s.sources || []);
          }, send);
        };
        send();
      };
      if (s.token === 'none') { make(); return; }
      C.out(esc(tf('proxy.tokenReplace', { n: (s.sources || []).length })), 'warn');
      askYN(t('proxy.tokenAsk'), make);
    });
  }
  /** @param {number} i */
  const copyBtn = function (i) { return '<button type="button" class="sgx-at-nm" data-at-act="sub-copy:' + i + '">' + esc(t('proxy.copy')) + '</button>'; };

  /** sub add <名称>：遮挡输入链接；同名即改链接（显示新旧域名再确认，先试拉成功才换） @param {string} name */
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

  /** sub upload <名称>：系统文件选择 → 读文本 → 字符进度条 → 上传（同名即覆盖） @param {string} name */
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

  /** sub mv <旧名> <新名>：只改名，不刷新；确认时显示新旧路径（令牌遮挡） @param {string} a @param {string} b */
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

  /** sub on / sub off <名称> @param {string} name @param {boolean} on */
  function cmdToggle(name, on) {
    dim(t('proxy.refreshing'));
    call(function () { return P.toggle(name, on); }, function (j) {
      C.ok('✓ ' + tf('proxy.switched', { v: name, s: t(on ? 'proxy.enabled' : 'proxy.disabled') }));
      printRefresh(j.refresh);
    });
  }

  /** sub update <名称>：立即拉这一个机场源 @param {string} name */
  function cmdUpdate(name) {
    dim(t('proxy.refreshing'));
    call(function () { return P.update(name); }, function (j) {
      C.ok('✓ ' + tf('proxy.updated', { v: name }));
      printRefresh(j.refresh);
    });
  }

  /** 一个映射：源词 → 国旗 码 @param {any} f */
  const flagLine = function (f) { return '<span translate="no">' + esc(f.word) + '</span> <span class="sgx-at-dim">→</span> ' + esc(f.flag + ' ' + f.code); };

  /** sub map 的业务失败：源词已在另一边 / 没有这个源词 @param {string} w @returns {(j: any) => boolean} */
  const mapFailed = function (w) {
    return function (j) {
      if (j.error === 'exists') { C.err(j.as === 'drop' ? tf('proxy.mapIsDrop', { w: w }) : tf('proxy.mapIsFlag', { w: w, f: j.flag || '', c: j.as || '' })); return true; }
      if (j.error === 'not-found') { C.err(tf('proxy.wordNotFound', { w: w })); return true; }
      return false;
    };
  };

  /** sub map …（参数已由 checkMap 查过） @param {string[]} a */
  function cmdMap(a) {
    const head = (a[0] || '').toLowerCase();
    if (!a.length) {
      call(function () { return P.map(); }, function (j) {
        const flags = j.flags || [];
        const drop = j.drop || [];
        if (!flags.length && !drop.length) { dim(t('proxy.mapEmpty')); return; }
        for (const f of flags) C.out(flagLine(f));
        if (drop.length) C.out('<span class="sgx-at-dim">' + esc(t('proxy.mapDropLabel')) + '</span> <span translate="no">' + esc(drop.join(' ')) + '</span>');
      });
      return;
    }
    if (head === 'ls') {
      const name = a[1];
      call(function () { return P.mapLs(name); }, function (j) {
        const names = j.names || [];
        if (!names.length) { dim(tf('proxy.lsNone', { v: name })); return; }
        for (const n of names) C.out('<span translate="no">' + esc(n) + '</span>');
      });
      return;
    }
    if (head === 'rm') {
      const w = a[1].trim().toLowerCase();
      call(function () { return P.mapRm(w); }, function (j) { C.ok('✓ ' + tf('proxy.mapRemoved', { w: w })); printRefresh(j.refresh); }, undefined, mapFailed(w));
      return;
    }
    const w = a[0].trim().toLowerCase();
    const code = a[1];
    call(function () { return P.mapSet(w, code); }, function (j) {
      if (j.drop) C.ok('✓ ' + tf('proxy.dropAdded', { w: w, n: j.dropped || 0 }));
      else C.ok('✓ ' + tf(j.changed ? 'proxy.mapChanged' : 'proxy.mapAdded', { w: w, f: j.flag || '', c: j.code || '' }));
      printRefresh(j.refresh);
    }, undefined, mapFailed(w));
  }

  /** sub fp [值]：看 / 改指纹 @param {string} [v] */
  function cmdFp(v) {
    if (!v) { call(function () { return P.fp(); }, function (j) { C.out(esc(tf('proxy.fpNow', { v: j.fp }))); }); return; }
    const val = v.toLowerCase();
    call(function () { return P.fp(val); }, function (j) { C.ok('✓ ' + tf('proxy.fpSet', { v: j.fp })); printRefresh(j.refresh); });
  }

  /** sub rm <名称>（y/N） @param {string} name */
  function cmdRm(name) {
    withStatus(function (s) {
      if (!find(s, name)) { C.err(tf('proxy.notFound', { v: name })); return; }
      askYN(tf('proxy.rmAsk', { v: name }), function () {
        call(function () { return P.rm(name); }, function (j) { C.ok('✓ ' + tf('proxy.removed', { v: name })); printRefresh(j.refresh); });
      });
    });
  }

  /** 子命令 → 做什么（参数已由 checkSub 查过） */
  const RUN = /** @type {Record<string, (a: string[]) => void>} */ ({
    '': function () { withStatus(printStatus); },
    'show': function (a) { cmdShow(a[0]); },
    'add': function (a) { cmdAdd(a[0]); },
    'upload': function (a) { cmdUpload(a[0]); },
    'mv': function (a) { cmdMv(a[0], a[1]); },
    'rm': function (a) { cmdRm(a[0]); },
    'on': function (a) { cmdToggle(a[0], true); },
    'off': function (a) { cmdToggle(a[0], false); },
    'update': function (a) { cmdUpdate(a[0]); },
    'map': function (a) { cmdMap(a); },
    'fp': function (a) { cmdFp(a[0]); },
    'key': function () { cmdKey(); },
    'token': function () { cmdToken(); },
  });

  /**
   * 跑一行 sub（runCmd 已回显）：终端 cmds/sub 判过是 v6 root；查参数，再分发。
   * @param {string} raw 原样的一行
   */
  C.cmdSub = function (raw) {
    const p = parseSub(raw);
    if (!p) return;
    const bad = checkSub(p);
    if (bad) {
      C.err('usage' in bad ? tf('proxy.usage', { x: bad.usage }) : 'badWord' in bad ? t('proxy.err.word') : 'badCode' in bad ? t('proxy.err.bad-code') : t('proxy.badName'));
      return;
    }
    RUN[p.sub](p.args);
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
  /** 关终端：印过的地址不留在内存里 */
  C.forgetProxy = function () { urls = []; };
}
