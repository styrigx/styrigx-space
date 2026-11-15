#!/usr/bin/env node
/**
 * @fileoverview 分层与骨架检查：前端分组与 space 骨架（规则 1–9、23–28，space/README.md §3–4），Worker 边界（规则 14–22，docs/architecture/overview.md §7）。
 *
 * 每个相对 import 都解析成真实文件，再按目标文件所在目录判层（不再按文件名猜）。
 * 解析不到文件的相对 import 直接报错：以前这种情况记成 'unknown' 并且放行，
 * api → api（'./lock-reauth.js'）、api → middleware（'../_middleware.js'）都因此漏检。
 *
 * 前端（space/web/assets/common/js/）：
 *  前端分组（space/README.md §1.1，迁移第 2 步起）分三层，下层不许 import 上层：
 *    基础层 core/ i18n/ prefs/ ui/ features/ status/（原 lib/）
 *    功能层 auth/ 与 term/ account/ identity/ nav/ ai/ topbar/ music/（原 auth/、shell/）
 *    应用层 apps/（apps/entries/ 是页面入口）
 *  改名定稿 v1.6 起：topbar/ nav/ term/ ai/ apps/ status/ account/（identity 并进 account/identity/）放在 frame/ 下，
 *  层名仍按 frame/ 下一级目录判（frame/account/identity/ 算 account）；common 不许依赖 frame 见规则 28。
 *  1. 基础层只能 import 基础层
 *  2. auth/ 只能 import 基础层和 auth/（鉴权与凭证流程；不得 import 其它功能组、apps/）
 *  3. 功能组（auth/ 以外）不得 import apps/
 *  4. apps/ 不得 import apps/entries/
 *  5. 前端不得 import space/web/assets/common/js/ 以外的文件（前后端隔离，含 functions/、workers/）
 *  6. 基础层（原 lib/）不得包含鉴权逻辑：不得出现鉴权接口地址（/api/lock-*、/api/space-*、/api/account）
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
 * 22. 退役名单（space/scripts/check/retired-names.json 的 account）里的旧名字不许出现在账号 Worker（workers/account/src/）
 *     和账号前端（space/web/assets/common/js/frame/account/）——注释也算，旧名字只留在退役名单这一处
 *     （19–21 的 Worker 目录 = workers/ 下有 wrangler.toml 的子目录；workers/ 下每个子目录都得有 wrangler.toml，
 *     tests/space/ui/build/check-layers.test.mjs 核对。只管这四条，依赖方向不在这里查）
 *
 * space 骨架契约（space/README.md，《space 架构规范 v1.8》，2026-11-13）：
 * 23. Platform 不依赖 Products：Platform 的 JS / CSS / 模板不许 import、@import、partial、resources.Get、site.Data.<产品> 任何产品的东西
 * 24. Products 之间不互相引用（判的是被引用对象属于哪个产品）
 * 25. 前端（space/web/assets/** 的 JS / CSS）不许引用 space/web/assets/ 以外的文件；相对引用必须解析到真实文件
 *     （规则 5 的扩展：规则 5 只管 assets/js/，迁移完 assets/js/ 后两条合一）
 * 26. 落点：space/web/{assets,layouts,data}、space/scripts 下每个文件必须在 ALLOWED_PLACES 里，
 *     或者在待迁移表 space/scripts/check/layers-pending.json 里（只许删不许加：表里的文件必须还在、且还不在目标位置）
 * 27. 例外：space/scripts/check/layers-exceptions.json，只对 23–26、28 生效，每条必须有 reason；用不上的例外报错
 *     （规范 v1.8：例外要写下来、说清楚原因，不悄悄绕过）
 *     23–28 只在仓库根有 space/README.md 时查（单测的临时小仓库没有）；命令行直接跑时缺 README 就报错。
 *
 * common 分层（目录改名定稿 v1.6 §3，2026-11-13）：
 * 28. common 的库（space/web/assets/common/js/ 下 frame/ 以外的文件）不许 import 外壳 frame/（common/js/frame/**）；
 *     common 是底座，frame 是建在底座上的外壳。允许例外（写进例外表与 space/README.md §5）。
 *
 * 用法：node space/scripts/check/check-layers.mjs [--root <仓库根>]
 * 规则函数导出给 tests/space/ui/build/check-layers.test.mjs 用。
 */
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative, dirname, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';

const DEFAULT_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

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
  if (rel.startsWith('space/web/assets/common/js/frame/apps/entries/')) return { area: 'frontend', layer: 'entries', rel, frame: true };
  let m = rel.match(/^space\/web\/assets\/common\/js\/frame\/([^/]+)\//);
  if (m) return { area: 'frontend', layer: m[1], rel, frame: true };
  m = rel.match(/^space\/web\/assets\/common\/js\/([^/]+)\//);
  if (m) return { area: 'frontend', layer: m[1], rel };
  if (rel.startsWith('space/web/assets/common/js/')) return { area: 'frontend', layer: '(root)', rel };
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
export const FE_BASE = Object.freeze(['core', 'i18n', 'prefs', 'ui', 'features', 'status']);
export const FE_FEATURE = Object.freeze(['term', 'account', 'identity', 'nav', 'ai', 'topbar', 'music']);
const FRONTEND_ALLOWED = {
  ...Object.fromEntries(FE_BASE.map((g) => [g, new Set(FE_BASE)])),
  auth: new Set([...FE_BASE, 'auth']),
  ...Object.fromEntries(FE_FEATURE.map((g) => [g, new Set([...FE_BASE, 'auth', ...FE_FEATURE])])),
  apps: new Set([...FE_BASE, 'auth', ...FE_FEATURE, 'apps']),
  entries: new Set([...FE_BASE, 'auth', ...FE_FEATURE, 'apps', 'entries']),
};

/* 规则 6：基础层（原 lib/）里不许出现的鉴权痕迹 */
const LIB_AUTH_RE = /\/api\/(?:lock-|space-|account\b)|navigator\s*\.\s*credentials/;

const EXTERNAL_OK = new Set(['cloudflare:workers']);
/** 规则 14 的按文件例外（只此一处）：proxy-rules 的 age 加密（wrangler.toml 开 nodejs_compat） */
export const EXTERNAL_BY_FILE = Object.freeze({ 'workers/proxy/src/lib/age.js': Object.freeze(['node:crypto']) });

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
export const RETIRED_SCOPE_RE = /^(?:workers\/account\/src\/|space\/web\/assets\/common\/js\/frame\/account\/)/;
/** @type {string[]|null} */
let retiredCache = null;
/** 退役名单（space/scripts/check/retired-names.json 的 account） */
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
    if (ln >= 0) errors.push(`${rel}:${ln + 1}: 退役旧名 ${name}（规则 22：账号命名 v2 起只留在 space/scripts/check/retired-names.json）`);
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
        errors.push(`${r}: 前端禁止 import space/web/assets/common/js/ 以外的文件 (${spec})`);
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
    if (FE_BASE.includes(self.layer) && LIB_AUTH_RE.test(code)) {
      errors.push(`${r}: 基础层 ${self.layer}/ 不得包含鉴权逻辑（鉴权接口 / navigator.credentials 放 auth/）`);
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


/* ───────────── space 骨架契约（规则 23–28，space/README.md） ───────────── */

export const PRODUCTS = Object.freeze(['blog', 'curio', 'daymark']);

/** 规则 26：允许的落点（和 space/README.md §1–§2 一致；改骨架两边同一个 PR 改） */
export const ALLOWED_PLACES = Object.freeze([
  /^space\/web\/assets\/common\/css\/.+/,
  /^space\/web\/assets\/common\/js\/(?:core|i18n|prefs|ui|features|auth|music)\/.+/,
  /^space\/web\/assets\/common\/js\/frame\/(?:topbar|nav|term|ai|apps|status|account)\/.+/,
  /^space\/web\/assets\/common\/js\/tsconfig\.json$/,
  /^space\/web\/assets\/(?:blog|curio|daymark)\/(?:css|js)\/.+/,
  /^space\/web\/layouts\/[^/]+$/,
  /^space\/web\/layouts\/(?:_default|common|blog|curio|daymark)\/.+/,
  /^space\/web\/layouts\/partials\/(?:common|blog|curio|daymark)\/.+/,
  /^space\/web\/data\/(?:common|blog|curio|daymark)\/.+/,
  /^space\/scripts\/(?:lib|build|check|gen|deploy|blog|curio|daymark)\/.+/,
  /^space\/README\.md$/,
]);
const PLACE_SCOPE_RE = /^space\/(?:web\/(?:assets|layouts|data)|scripts)\//;

export const PENDING_FILE = 'space/scripts/check/layers-pending.json';

/** 规则 28：common 的库（common/js/ 下 frame/ 以外）与外壳（common/js/frame/） */
export const FRAME_RE = /^space\/web\/assets\/common\/js\/frame\//;
export const COMMON_LIB_RE = /^space\/web\/assets\/common\/js\/(?!frame\/)/;
export const EXCEPTIONS_FILE = 'space/scripts/check/layers-exceptions.json';

/**
 * 文件归谁：某个产品，或 platform；不在 space/web 下 → null。
 * @param {string} rel 仓库相对路径
 */
export function ownerOf(rel) {
  if (!rel.startsWith('space/web/')) return null;
  const m = rel.match(/^space\/web\/(?:assets|data|layouts\/partials|layouts)\/(blog|curio|daymark)\//);
  return m ? m[1] : 'platform';
}

/**
 * 模板里的引用：partial / partialCached / template、resources.Get / GetMatch / Match、site.Data.<键>、index site.Data "<键>"。
 * 变量拼出来的路径查不到（只认字符串字面量）。
 * @param {string} src
 * @returns {{line:number, kind:'partial'|'resource'|'data', name:string, text:string}[]}
 */
export function templateRefsOf(src) {
  const out = [];
  const re = /\b(?:partial|partialCached|template)\s+"([^"]+)"|\bresources\.(?:Get|GetMatch|Match)\s+"([^"]+)"|(?:\bsite|\.Site|\bhugo)\.Data\.([A-Za-z_][\w-]*)|\bindex\s+(?:site|\$?\.Site)\.Data\s+"([^"]+)"/g;
  const lines = src.split('\n');
  for (let i = 0; i < lines.length; i++) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(lines[i]))) {
      if (m[1] !== undefined) {
        if (m[1].startsWith('_internal/')) continue;
        out.push({ line: i + 1, kind: 'partial', name: m[1], text: m[0] });
      } else if (m[2] !== undefined) out.push({ line: i + 1, kind: 'resource', name: m[2], text: m[0] });
      else out.push({ line: i + 1, kind: 'data', name: m[3] ?? m[4], text: m[0] });
    }
  }
  return out;
}

/** 模板引用的目标归谁 @param {{kind:string, name:string}} ref */
function refOwner(ref) {
  if (ref.kind === 'partial') return ownerOf('space/web/layouts/partials/' + ref.name);
  if (ref.kind === 'resource') return ownerOf('space/web/assets/' + ref.name);
  return PRODUCTS.includes(ref.name) ? ref.name : 'platform';
}

/** CSS 的 @import 目标（只认相对路径字面量） @param {string} src */
export function cssImportsOf(src) {
  const out = [];
  const re = /@import\s+(?:url\(\s*)?['"]([^'"]+)['"]/g;
  const code = src.replace(/\/\*[\s\S]*?\*\//g, (t) => t.replace(/[^\n]/g, ' '));
  let m;
  while ((m = re.exec(code))) out.push(m[1]);
  return out;
}

/**
 * 23 / 24 的判定：from 引用 to 是否越界。
 * @returns {''|'23'|'24'}
 */
export function crossRule(fromOwner, toOwner) {
  if (!fromOwner || !toOwner || fromOwner === toOwner || toOwner === 'platform') return '';
  return fromOwner === 'platform' ? '23' : '24';
}

/**
 * 读例外表：[{rule, file, ref?, reason}]。没写 reason 的直接报错。
 * @param {string} root
 */
export function loadExceptions(root) {
  const p = join(root, EXCEPTIONS_FILE);
  const errors = [];
  if (!existsSync(p)) return { list: [], errors: [`${EXCEPTIONS_FILE}: 缺例外表（规则 27：没有例外也要留一个空数组 "exceptions": []）`] };
  let list = [];
  try { list = JSON.parse(readFileSync(p, 'utf8')).exceptions; } catch (e) { return { list: [], errors: [`${EXCEPTIONS_FILE}: 不是合法 JSON（${e.message}）`] }; }
  if (!Array.isArray(list)) return { list: [], errors: [`${EXCEPTIONS_FILE}: exceptions 必须是数组`] };
  list.forEach((x, i) => {
    if (!x || !['23', '24', '25', '26', '28'].includes(String(x.rule)) || typeof x.file !== 'string' || !x.file) {
      errors.push(`${EXCEPTIONS_FILE}: 第 ${i + 1} 条要有 rule（23–26、28）和 file`);
    }
    if (!x || typeof x.reason !== 'string' || !x.reason.trim()) {
      errors.push(`${EXCEPTIONS_FILE}: 第 ${i + 1} 条（${x && x.file}）没写 reason（规则 27：例外要写下来、说清楚原因）`);
    }
  });
  return { list, errors };
}

/**
 * 23–27：space 骨架契约。
 * @param {string} root
 * @param {{files?: string[]}} [opts] files：参与落点检查的仓库相对路径（默认 git ls-files，失败就扫目录）
 * @returns {{files:number, errors:string[]}}
 */
export function checkSpace(root, opts = {}) {
  const raw = [];
  const ex = loadExceptions(root);
  raw.push(...ex.errors.map((e) => ({ msg: e })));

  /* JS 与 CSS：space/web/assets/** */
  const assetsDir = join(root, 'space/web/assets');
  const feFiles = [];
  (function walkAll(dir) {
    if (!existsSync(dir)) return;
    for (const e of readdirSync(dir)) {
      if (['node_modules', 'public', '.git'].includes(e)) continue;
      const p = join(dir, e);
      if (statSync(p).isDirectory()) walkAll(p);
      else if (/\.(?:m?js|cjs|css)$/.test(e)) feFiles.push(p);
    }
  })(assetsDir);
  for (const abs of feFiles) {
    const rel = relative(root, abs).split(sep).join('/');
    const src = readFileSync(abs, 'utf8');
    const isCss = rel.endsWith('.css');
    /* 生成物（main.css 等，不进仓库）跳过：它们由 @import 展开，查源头就够了 */
    if (isCss && /\/main\.css$/.test(rel)) continue;
    const specs = isCss ? cssImportsOf(src) : importsOf(stripComments(src));
    for (const spec of specs) {
      if (!spec.startsWith('.')) continue;
      const target = resolve(dirname(abs), spec);
      const tRel = relative(root, target).split(sep).join('/');
      if (!tRel.startsWith('space/web/assets/')) {
        raw.push({ rule: '25', file: rel, ref: tRel, msg: `${rel}: 前端不许引用 space/web/assets/ 以外的文件 ${tRel}（规则 25）` });
        continue;
      }
      if (!existsSync(target) || statSync(target).isDirectory()) {
        raw.push({ rule: '25', file: rel, ref: tRel, msg: `${rel}: 引用的文件不存在（${spec}）（规则 25）` });
        continue;
      }
      const rule = crossRule(ownerOf(rel), ownerOf(tRel));
      if (rule) raw.push({ rule, file: rel, ref: tRel, msg: crossMsg(rule, rel, ownerOf(rel), ownerOf(tRel), tRel) });
      if (COMMON_LIB_RE.test(rel) && FRAME_RE.test(tRel)) {
        raw.push({ rule: '28', file: rel, ref: tRel, msg: `${rel}: common 的库不许依赖外壳 frame/（规则 28），发现 ${tRel}` });
      }
    }
  }

  /* 模板：space/web/layouts/** */
  const layoutFiles = [];
  (function walkAll(dir) {
    if (!existsSync(dir)) return;
    for (const e of readdirSync(dir)) {
      const p = join(dir, e);
      if (statSync(p).isDirectory()) walkAll(p);
      else layoutFiles.push(p);
    }
  })(join(root, 'space/web/layouts'));
  for (const abs of layoutFiles) {
    const rel = relative(root, abs).split(sep).join('/');
    const from = ownerOf(rel);
    for (const ref of templateRefsOf(readFileSync(abs, 'utf8'))) {
      const to = refOwner(ref);
      const rule = crossRule(from, to);
      if (rule) raw.push({ rule, file: rel, ref: ref.name, msg: crossMsg(rule, `${rel}:${ref.line}`, from, to, ref.text) });
    }
  }

  /* 落点 */
  const files = (opts.files || listFiles(root)).filter((f) => PLACE_SCOPE_RE.test(f) || f === 'space/README.md');
  const pendingPath = join(root, PENDING_FILE);
  let pending = [];
  if (!existsSync(pendingPath)) raw.push({ msg: `${PENDING_FILE}: 缺待迁移表（规则 26：迁移完了留一个空数组 "pending": []）` });
  else {
    try { pending = JSON.parse(readFileSync(pendingPath, 'utf8')).pending || []; } catch (e) { raw.push({ msg: `${PENDING_FILE}: 不是合法 JSON（${e.message}）` }); }
  }
  const pendingSet = new Set(pending);
  const fileSet = new Set(files);
  const allowed = (f) => ALLOWED_PLACES.some((re) => re.test(f));
  for (const f of files) {
    if (allowed(f) || pendingSet.has(f)) continue;
    raw.push({ rule: '26', file: f, msg: `${f}: 放错了地方（规则 26：落点见 space/README.md §2；迁移中的旧位置只认待迁移表里已有的文件，新文件不许进表）` });
  }
  for (const f of pending) {
    if (!fileSet.has(f)) raw.push({ msg: `${PENDING_FILE}: ${f} 已经不在了，从待迁移表删掉（规则 26）` });
    else if (allowed(f)) raw.push({ msg: `${PENDING_FILE}: ${f} 已在目标位置，从待迁移表删掉（规则 26）` });
  }

  /* 例外：按 rule + file（+ ref）匹配，用不上的报错 */
  const used = new Set();
  const errors = [];
  for (const r of raw) {
    if (r.rule) {
      const i = ex.list.findIndex((x) => x && String(x.rule) === r.rule && x.file === r.file && (!x.ref || x.ref === r.ref));
      if (i >= 0 && ex.list[i].reason && String(ex.list[i].reason).trim()) { used.add(i); continue; }
    }
    errors.push(r.msg);
  }
  ex.list.forEach((x, i) => {
    if (!used.has(i) && x && x.reason) errors.push(`${EXCEPTIONS_FILE}: 第 ${i + 1} 条例外（规则 ${x.rule} ${x.file}）已经用不上了，删掉（规则 27）`);
  });
  return { files: feFiles.length + layoutFiles.length, errors };
}

function crossMsg(rule, where, from, to, what) {
  return rule === '23'
    ? `${where}: Platform 不许依赖产品 ${to}（规则 23），发现 ${what}`
    : `${where}: 产品 ${from} 不许引用产品 ${to}（规则 24），发现 ${what}`;
}

/** git 里的文件（仓库相对路径）；不是 git 仓库就扫目录 @param {string} root */
function listFiles(root) {
  try {
    const out = execFileSync('git', ['-C', root, 'ls-files', '-z', '--', 'space/web/assets', 'space/web/layouts', 'space/web/data', 'space/scripts', 'space/README.md'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    return out.split('\0').filter(Boolean);
  } catch (e) {
    const out = [];
    (function walkAll(dir) {
      if (!existsSync(dir)) return;
      for (const e2 of readdirSync(dir)) {
        if (['node_modules', 'public', '.git'].includes(e2)) continue;
        const p = join(dir, e2);
        if (statSync(p).isDirectory()) walkAll(p);
        else out.push(relative(root, p).split(sep).join('/'));
      }
    })(join(root, 'space'));
    return out;
  }
}

/**
 * 查整个仓库。
 * @param {string} root
 * @param {{space?: boolean}} [opts] space：查 23–27（默认：仓库根有 space/README.md 才查）
 * @returns {{files:number, errors:string[]}}
 */
export function checkRepo(root, opts = {}) {
  const files = walk(join(root, 'space/web/assets/common/js')).concat(walk(join(root, 'workers')));
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
  let n = files.length;
  const space = opts.space ?? existsSync(join(root, 'space/README.md'));
  if (space) {
    if (!existsSync(join(root, 'space/README.md'))) errors.push('space/README.md: 缺 space 骨架契约（规则 23–27 的依据）');
    const r = checkSpace(root);
    errors.push(...r.errors);
    n += r.files;
  }
  return { files: n, errors };
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  const i = process.argv.indexOf('--root');
  const root = i > 0 ? resolve(process.argv[i + 1]) : DEFAULT_ROOT;
  const { files, errors } = checkRepo(root, { space: true });
  if (errors.length) {
    console.error('check-layers.mjs: 发现分层违规：');
    for (const e of errors) console.error('  ✗ ' + e);
    process.exit(1);
  }
  console.log(`check-layers.mjs: 通过（检查了 ${files} 个文件）`);
}
