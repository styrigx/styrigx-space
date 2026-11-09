#!/usr/bin/env node
/**
 * @fileoverview L0-L6 分层边界检查（SGX 3.0 架构规范，docs/architecture/overview.md §6–7）。
 *
 * 每个相对 import 都解析成真实文件，再按目标文件所在目录判层（不再按文件名猜）。
 * 解析不到文件的相对 import 直接报错：以前这种情况记成 'unknown' 并且放行，
 * api → api（'./lock-reauth.js'）、api → middleware（'../_middleware.js'）都因此漏检。
 *
 * 前端（space/web/assets/js/）：
 *  1. lib/ 只能 import lib/（不得 import auth/、shell/、apps/、entries/）
 *  2. auth/ 只能 import lib/、auth/（鉴权与凭证流程；不得 import shell/、apps/、entries/）
 *  3. shell/ 不得 import apps/、entries/
 *  4. apps/ 不得 import entries/
 *  5. 前端不得 import space/web/assets/js/ 以外的文件（前后端隔离，含 functions/、workers/）
 *  6. lib/ 不得包含鉴权逻辑：不得出现鉴权接口地址（/api/lock-*、/api/space-*、/api/account）
 *     和 navigator.credentials（这些放 auth/）
 *  7. 前端代码禁止出现 cookie 名 `sgx-space-session`（HttpOnly，前端读不到；`data-sgx-lock-session` 属性名不算）
 *  8. 前端代码禁止出现 `sgx-lock-shown` 字符串
 *  9. 前端代码不得用 sessionStorage/localStorage 保存解锁状态
 *     （key 匹配：unlock、sgx-lock、session；storage.js 本身除外）
 *
 * 10–13（网关 functions/_kernel、functions/api、_middleware、src 之间的方向）：2026-11-02 Worker 骨架统一后网关没有 functions/ 了，
 *     这四条随之退役（编号不复用）；防止退回旧目录的是规则 18。
 *
 * 所有 Worker（workers/<名字>/，2026-10-30 起没有共享目录，每个 Worker 各自实现）：
 * 14. 每个 Worker 只能相对 import 自己目录 workers/<名字>/ 下的文件；账号（workers/account/）和网关（workers/space-core/）
 *     互相不许 import，别的 Worker 之间也一样，没有任何例外；非相对 import 只认 cloudflare:workers
 *     （唯一的按文件例外 EXTERNAL_BY_FILE：proxy-rules 的 age 加密要 node:crypto 的 chacha20-poly1305，WebCrypto 没有；2026-11-10）
 * 15. 不许有 workers/shared（2026-10-30 删除，账号拆分 PR3a）：目录本身存在就失败，任何文件 import workers/shared/ 也失败
 *
 * Worker 边界（账号拆分 PR3e，按 PR3d 之后的事实）：
 * 16. 网关源码（workers/space-core/ 下的 .js / .mjs / .cjs 和 wrangler.toml）去掉注释后不许出现账号鉴权标识
 *     （GATEWAY_ACCOUNT_AUTH_RE：SGX_ACCOUNT_*、SGX_ROOT_KEY、D1_ACCOUNT（含旧名）、D1_ROOT_AUTH、REALM_ACCOUNT、REALM_ROOT、
 *     checkAccountSession、verifyAccountSession、Account*Ticket / ACCOUNT_*_TICKET、账号 cookie 名等）。
 *     账号鉴权全在账号 Worker；网关只经 ACCOUNT_VERIFIER.authorize() 拿结论，旧首帧提示属性名 data-sgx-account-session（网关只清不写）不算。
 * 17. 账号 Worker 的 workers/account/wrangler.toml 不许有路由：[[routes]] / [[env.*.routes]]、route = …、非空的 routes = [...]
 *     （[env.preview] 的 routes = [] 允许）；账号请求只经网关的服务绑定 ACCOUNT / ACCOUNT_VERIFIER 进来。
 *
 * Worker 骨架防回退（2026-11-02，骨架契约见 workers/README.md）：
 * 18. workers/** 下不许有 functions/ 或 _kernel/ 目录（Pages Functions 时代的旧目录，网关 2026-11-02 已全部并进 src/）
 * 19. 每个 Worker 的 wrangler.toml 顶层 main 必须是 "src/index.js"
 * 20. 每个 Worker 目录必须有 README.md
 * 21. 每个 Worker 的 package.json 必须有非空字符串 name
 *
 * 账号命名 v2（2026-11-08）：
 * 22. 退役名单（space/scripts/retired-names.json 的 account）里的旧名字不许出现在账号 Worker（workers/account/src/）
 *     和账号前端（space/web/assets/js/shell/account/）——注释也算，旧名字只留在退役名单这一处
 *     （19–21 的 Worker 目录 = workers/ 下有 wrangler.toml 的子目录；workers/ 下每个子目录都得有 wrangler.toml，
 *     tests/space/ui/build/check-layers.test.mjs 核对。只管这四条，依赖方向不在这里查）
 *
 * 用法：node space/scripts/check-layers.mjs [--root <仓库根>]
 * 规则函数导出给 tests/space/ui/build/check-layers.test.mjs 用。
 */
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative, dirname, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const DEFAULT_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** @param {string} dir @param {string[]} [out] */
export function walk(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) {
      if (['node_modules', 'public', '.git', '.hugo_build.lock', '.wrangler'].includes(e)) continue;
      walk(p, out);
    } else if (p.endsWith('.js') || p.endsWith('.mjs') || p.endsWith('.cjs')) {
      out.push(p);
    }
  }
  return out;
}

/**
 * import 路径（静态 import / export … from / 动态 import()）。
 * @param {string} src
 * @returns {string[]}
 */
export function importsOf(src) {
  const out = [];
  const re = /(?:\bimport\s+(?:[^'"()]*?\s+from\s+)?|\bexport\s+(?:\*|\{[^}]*\})\s*(?:as\s+\w+\s+)?from\s+|\bimport\s*\(\s*)['"]([^'"]+)['"]/g;
  let m;
  while ((m = re.exec(src))) out.push(m[1]);
  return out;
}

/**
 * 去掉注释（规则 6-8 只查代码）。字符串里的 // 不当注释（URL 常见），模板字符串按普通字符串处理。
 * @param {string} src
 */
export function stripComments(src) {
  let out = '';
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    const d = src[i + 1];
    if (c === '/' && d === '*') {
      const end = src.indexOf('*/', i + 2);
      i = end < 0 ? n : end + 2;
      out += ' ';
      continue;
    }
    if (c === '/' && d === '/') {
      const end = src.indexOf('\n', i);
      i = end < 0 ? n : end;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      let j = i + 1;
      while (j < n && src[j] !== c) {
        if (src[j] === '\\') j++;
        else if (c !== '`' && src[j] === '\n') break;
        j++;
      }
      out += src.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

/**
 * 文件所在层。
 * @param {string} root 仓库根
 * @param {string} abs 绝对路径
 * @returns {{area:'frontend'|'gateway'|'worker'|'other', layer:string, rel:string, worker?:string}}
 *   gateway / worker 带 worker（workers/ 下的目录名）
 */
export function layerOf(root, abs) {
  const rel = relative(root, abs).split(sep).join('/');
  let m = rel.match(/^space\/web\/assets\/js\/([^/]+)\//);
  if (m) return { area: 'frontend', layer: m[1], rel };
  if (rel.startsWith('space/web/assets/js/')) return { area: 'frontend', layer: '(root)', rel };
  const g = gatewayLayer(rel);
  if (g) return { area: 'gateway', layer: g, rel, worker: 'space-core' };
  m = rel.match(/^workers\/([^/]+)\//);
  if (m) return { area: 'worker', layer: m[1], rel, worker: m[1] };
  return { area: 'other', layer: 'other', rel };
}

/** 网关内的层（2026-11-02 起只分 src / 其他，方向规则 10–13 随 functions/ 一起退役）；不在网关目录 → null @param {string} rel */
function gatewayLayer(rel) {
  if (rel.startsWith('workers/space-core/src/')) return 'src';
  if (rel.startsWith('workers/space-core/')) return 'gateway-other';
  return null;
}

/** 前端各层可 import 的层 */
const FRONTEND_ALLOWED = {
  lib: new Set(['lib']),
  auth: new Set(['lib', 'auth']),
  shell: new Set(['lib', 'auth', 'shell']),
  apps: new Set(['lib', 'auth', 'shell', 'apps']),
  entries: new Set(['lib', 'auth', 'shell', 'apps', 'entries']),
};

/* 规则 6：lib/ 里不许出现的鉴权痕迹 */
const LIB_AUTH_RE = /\/api\/(?:lock-|space-|account\b)|navigator\s*\.\s*credentials/;

const EXTERNAL_OK = new Set(['cloudflare:workers']);
/** 规则 14 的按文件例外（只此一处）：proxy-rules 的 age 加密（wrangler.toml 开 nodejs_compat） */
export const EXTERNAL_BY_FILE = Object.freeze({ 'workers/proxy-rules/src/lib/age.js': Object.freeze(['node:crypto']) });

/* 规则 15 */
export const SHARED_DIR = 'workers/shared';

/* 规则 16：网关源码里不许出现的账号鉴权标识（参照 PR3d 的残留 grep 列表；大小写敏感） */
export const GATEWAY_ACCOUNT_AUTH_RE = new RegExp([
  String.raw`\bSGX_ACCOUNT_\w+`,
  String.raw`\bSGX_ROOT_KEY\b`,
  String.raw`\bD1_ACCOUNT(?:_AUTH)?\b`,
  String.raw`\bD1_ROOT_AUTH\b`,
  String.raw`\bREALM_ACCOUNT\b`,
  String.raw`\bREALM_ROOT\b`,
  String.raw`\b(?:BY|KEY|LAYER|PASSKEY)_ACCOUNT\b`,
  String.raw`\bACCOUNT_EPOCH\b`,
  String.raw`\bACCOUNT_(?:SESSION|REAUTH|RESET)_[A-Z_]+\b`,
  String.raw`\b(?:check|verify|issue|clear)AccountSession\w*`,
  String.raw`\w*Account\w*Ticket\b`,
  String.raw`\b(?:bump|get)AccountEpoch\b`,
  String.raw`\b(?:accountKeysReady|accountConfigMissing|isAccountEffectivelyConfigured)\b`,
  String.raw`(?<!data-)\bsgx-account-(?:session|reauth|reset)\b`,
].join('|'), 'g');

/**
 * 把注释换成空格（换行保留，行号对得上）。字符串规则同 stripComments。
 * @param {string} src
 */
export function maskComments(src) {
  let out = '';
  let i = 0;
  const n = src.length;
  const blank = (t) => t.replace(/[^\n]/g, ' ');
  while (i < n) {
    const c = src[i];
    const d = src[i + 1];
    if (c === '/' && d === '*') {
      const end = src.indexOf('*/', i + 2);
      const j = end < 0 ? n : end + 2;
      out += blank(src.slice(i, j));
      i = j;
      continue;
    }
    if (c === '/' && d === '/') {
      const end = src.indexOf('\n', i);
      const j = end < 0 ? n : end;
      out += blank(src.slice(i, j));
      i = j;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      let j = i + 1;
      while (j < n && src[j] !== c) {
        if (src[j] === '\\') j++;
        else if (c !== '`' && src[j] === '\n') break;
        j++;
      }
      out += src.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

/**
 * TOML 去注释：每行 # 之后（不在引号里的）换成空，行数不变。
 * @param {string} src
 */
export function stripTomlComments(src) {
  return src.split('\n').map((line) => {
    let q = '';
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (q) {
        if (c === '\\' && q === '"') i++;
        else if (c === q) q = '';
      } else if (c === '"' || c === "'") q = c;
      else if (c === '#') return line.slice(0, i);
    }
    return line;
  }).join('\n');
}

/**
 * 规则 16：网关源码里的账号鉴权标识（注释除外）。
 * @param {string} rel 仓库相对路径（报错用）
 * @param {string} src 源码
 * @param {'js'|'toml'} [kind]
 * @returns {string[]}
 */
export function checkGatewayAccountAuth(rel, src, kind = 'js') {
  const code = kind === 'toml' ? stripTomlComments(src) : maskComments(src);
  const errors = [];
  const lines = code.split('\n');
  for (let ln = 0; ln < lines.length; ln++) {
    const re = new RegExp(GATEWAY_ACCOUNT_AUTH_RE.source, 'g');
    let m;
    while ((m = re.exec(lines[ln]))) {
      errors.push(`${rel}:${ln + 1}: 网关源码禁止出现账号鉴权标识 ${m[0]}（规则 16：账号鉴权只在 workers/account/，网关只经 ACCOUNT_VERIFIER.authorize() 拿结论）`);
    }
  }
  return errors;
}

/* 规则 22：退役名单的检查范围（账号 Worker 源码、账号前端） */
export const RETIRED_SCOPE_RE = /^(?:workers\/account\/src\/|space\/web\/assets\/js\/shell\/account\/)/;
/** @type {string[]|null} */
let retiredCache = null;
/** 退役名单（space/scripts/retired-names.json 的 account） */
export function retiredNames() {
  if (!retiredCache) retiredCache = JSON.parse(readFileSync(new URL('./retired-names.json', import.meta.url), 'utf8')).account;
  return /** @type {string[]} */ (retiredCache);
}

/**
 * 规则 22：文件里出现的退役旧名（整词匹配：前后不是字母数字下划线或连字符；注释也算）。
 * @param {string} rel @param {string} src
 * @returns {string[]}
 */
export function checkRetiredNames(rel, src) {
  const errors = [];
  const lines = String(src).split('\n');
  for (const name of retiredNames()) {
    const re = new RegExp('(?<![\\w-])' + name.replace(/[.*+?^${}()|[\]\\-]/g, '\\$&') + '(?![\\w-])');
    const ln = lines.findIndex((l) => re.test(l));
    if (ln >= 0) errors.push(`${rel}:${ln + 1}: 退役旧名 ${name}（规则 22：账号命名 v2 起只留在 space/scripts/retired-names.json）`);
  }
  return errors;
}

/**
 * 规则 17：账号 Worker 的 wrangler.toml 不许有路由。
 * @param {string} rel
 * @param {string} src
 * @returns {string[]}
 */
export function checkAccountToml(rel, src) {
  const errors = [];
  const lines = stripTomlComments(src).split('\n');
  for (let ln = 0; ln < lines.length; ln++) {
    const t = lines[ln].trim();
    let bad = '';
    if (/^\[\[\s*(?:env\.[\w-]+\.)?routes\s*\]\]$/.test(t)) bad = t;
    const kv = t.match(/^(?:env\.[\w-]+\.)?(route|routes)\s*=\s*(.*)$/);
    if (kv && (kv[1] === 'route' || !/^\[\s*\]$/.test(kv[2]))) bad = t;
    if (bad) errors.push(`${rel}:${ln + 1}: 账号 Worker 不许有公开路由，发现「${bad}」（规则 17：账号请求只经网关服务绑定 ACCOUNT 进来，路径在 workers/space-core/src/router.js 登记）`);
  }
  return errors;
}

/**
 * 查一个文件，返回违规列表。
 * @param {string} root
 * @param {string} abs
 * @param {string} [srcOverride] 测试用：不读盘，直接给源码
 * @returns {string[]}
 */
export function checkFile(root, abs, srcOverride) {
  const errors = [];
  const src = srcOverride === undefined ? readFileSync(abs, 'utf8') : srcOverride;
  const code = stripComments(src);
  const self = layerOf(root, abs);
  const r = self.rel;

  for (const spec of importsOf(code)) {
    if (!spec.startsWith('.')) {
      if (self.area === 'gateway' && !EXTERNAL_OK.has(spec)) {
        errors.push(`${r}: 网关只能 import 相对路径或 cloudflare:workers，发现 ${spec}`);
      } else if (self.area === 'worker' && !EXTERNAL_OK.has(spec) && !(EXTERNAL_BY_FILE[r] || []).includes(spec)) {
        errors.push(`${r}: Worker 只能 import 相对路径或 cloudflare:workers，发现 ${spec}`);
      }
      continue;
    }
    const target = resolve(dirname(abs), spec);
    const targetRel = relative(root, target).split(sep).join('/');
    if (targetRel === SHARED_DIR || targetRel.startsWith(SHARED_DIR + '/')) {
      errors.push(`${r}: 禁止 import workers/shared（规则 15：没有跨 Worker 的共享目录，每个 Worker 各自一份）(${spec})`);
      continue;
    }
    if (!existsSync(target) || statSync(target).isDirectory()) {
      errors.push(`${r}: import 的文件不存在（${spec}）`);
      continue;
    }
    const t = layerOf(root, target);

    if (self.area === 'frontend') {
      if (t.area !== 'frontend') {
        errors.push(`${r}: 前端禁止 import space/web/assets/js/ 以外的文件 (${spec})`);
        continue;
      }
      const allowed = FRONTEND_ALLOWED[self.layer];
      if (allowed && !allowed.has(t.layer)) {
        errors.push(`${r}: ${self.layer}/ 禁止 import ${t.layer}/ (${spec})`);
      }
      continue;
    }

    /* 规则 14：每个 Worker 只能 import 自己目录下的文件；账号和网关互相不许 import */
    if (self.area === 'gateway' || self.area === 'worker') {
      if (t.worker !== self.worker) {
        /* 规则 14 */
        const pair = new Set([self.worker, t.worker]);
        if (pair.has('account') && pair.has('space-core')) {
          errors.push(`${r}: 账号和网关互相不许 import，发现 ${t.rel} (${spec})`);
        } else if (self.area === 'gateway') {
          errors.push(`${r}: 网关禁止 import 网关目录以外的文件 (${spec})`);
        } else {
          errors.push(`${r}: Worker 只能 import 自己目录 workers/${self.worker}/ 下的文件，发现 ${t.rel} (${spec})`);
        }
        continue;
      }
    }

  }

  if (self.area === 'gateway') errors.push(...checkGatewayAccountAuth(r, src));
  if (RETIRED_SCOPE_RE.test(r)) errors.push(...checkRetiredNames(r, src));

  if (self.area === 'frontend') {
    if (self.layer === 'lib' && LIB_AUTH_RE.test(code)) {
      errors.push(`${r}: lib/ 不得包含鉴权逻辑（鉴权接口 / navigator.credentials 放 auth/）`);
    }
    if (/(?<!data-)sgx-space-session/.test(code)) {
      errors.push(`${r}: 前端禁止出现 sgx-space-session 字符串`);
    }
    if (code.includes('sgx-lock-shown')) {
      errors.push(`${r}: 前端禁止出现 sgx-lock-shown 字符串`);
    }
    if (!r.endsWith('/storage.js')) {
      const unlockKeyRe = /(?:sessionStorage|localStorage)\s*\.\s*setItem\s*\(\s*['"]([^'"]*(?:unlock|sgx-lock|sgx-unlock|session)[^'"]*)['"]/gi;
      let m;
      while ((m = unlockKeyRe.exec(code))) {
        errors.push(`${r}: 前端禁止用 storage 保存解锁状态 (key: ${m[1]})`);
      }
      const setJsonRe = /\bsetJSON\s*\(\s*['"]([^'"]*(?:unlock|sgx-lock|sgx-unlock)[^'"]*)['"]/gi;
      while ((m = setJsonRe.exec(code))) {
        errors.push(`${r}: 前端禁止用 storage 保存解锁状态 (setJSON key: ${m[1]})`);
      }
    }
  }
  return errors;
}

/** 规则 18：旧目录名 */
export const LEGACY_WORKER_DIRS = Object.freeze(['functions', '_kernel']);

/**
 * 规则 18–21：Worker 骨架防回退。
 * @param {string} root 仓库根
 * @returns {string[]}
 */
export function checkWorkerSkeleton(root) {
  const errors = [];
  const base = join(root, 'workers');
  if (!existsSync(base)) return errors;
  const workers = readdirSync(base, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort();
  for (const w of workers) {
    const dir = join(base, w);
    /* 规则 18 */
    const stack = [dir];
    while (stack.length) {
      const d = stack.pop();
      for (const e of readdirSync(d, { withFileTypes: true })) {
        if (!e.isDirectory() || e.name === 'node_modules' || e.name === '.wrangler') continue;
        const p = join(d, e.name);
        if (LEGACY_WORKER_DIRS.includes(e.name)) {
          errors.push(`${relative(root, p).split(sep).join('/')}: 不许有 ${e.name}/ 目录（规则 18：代码一律放 src/，骨架见 workers/README.md）`);
        }
        stack.push(p);
      }
    }
    /* 规则 19–21 只管 Worker 目录（有 wrangler.toml） */
    const tomlPath = join(dir, 'wrangler.toml');
    if (!existsSync(tomlPath)) continue;
    /* 规则 19 */
    {
      const top = stripTomlComments(readFileSync(tomlPath, 'utf8')).split(/^\s*\[/m)[0];
      const m = top.match(/^\s*main\s*=\s*"([^"]*)"\s*$/m);
      if (!m || m[1] !== 'src/index.js') {
        errors.push(`workers/${w}/wrangler.toml: main 必须是 "src/index.js"，现在是 ${m ? JSON.stringify(m[1]) : '（没写）'}（规则 19）`);
      }
    }
    /* 规则 20 */
    if (!existsSync(join(dir, 'README.md'))) errors.push(`workers/${w}: 缺 README.md（规则 20）`);
    /* 规则 21 */
    const pkgPath = join(dir, 'package.json');
    let name = null;
    if (existsSync(pkgPath)) {
      try { name = JSON.parse(readFileSync(pkgPath, 'utf8')).name; } catch (e) { name = null; }
    }
    if (typeof name !== 'string' || !name) errors.push(`workers/${w}/package.json: 必须有 name（规则 21）`);
  }
  return errors;
}

/**
 * 查整个仓库。
 * @param {string} root
 * @returns {{files:number, errors:string[]}}
 */
export function checkRepo(root) {
  const files = walk(join(root, 'space/web/assets/js')).concat(walk(join(root, 'workers')));
  const errors = [];
  for (const f of files) errors.push(...checkFile(root, f));
  if (existsSync(join(root, SHARED_DIR))) {
    errors.push(`${SHARED_DIR}: 不许存在（规则 15：2026-10-30 起没有跨 Worker 的共享目录，每个 Worker 各自实现）`);
  }
  const gwToml = join(root, 'workers/space-core/wrangler.toml');
  if (existsSync(gwToml)) errors.push(...checkGatewayAccountAuth('workers/space-core/wrangler.toml', readFileSync(gwToml, 'utf8'), 'toml'));
  const acToml = join(root, 'workers/account/wrangler.toml');
  if (existsSync(acToml)) errors.push(...checkAccountToml('workers/account/wrangler.toml', readFileSync(acToml, 'utf8')));
  errors.push(...checkWorkerSkeleton(root));
  return { files: files.length, errors };
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  const i = process.argv.indexOf('--root');
  const root = i > 0 ? resolve(process.argv[i + 1]) : DEFAULT_ROOT;
  const { files, errors } = checkRepo(root);
  if (errors.length) {
    console.error('check-layers.mjs: 发现分层违规：');
    for (const e of errors) console.error('  ✗ ' + e);
    process.exit(1);
  }
  console.log(`check-layers.mjs: 通过（检查了 ${files} 个文件）`);
}
