#!/usr/bin/env node
/**
 * 同步主站共享外壳（本仓库 styrigx/styrigx-space 的 web/atlas/shared/shell；2026-11-02 合并 PR1 之前在 web/shared/shell）：
 * 色彩角色、顶栏材质、导航抽屉、自定义主题色引擎、抽屉项。主站是唯一来源；本站只存一份「供应商副本」，放在标记段 / 供应商目录里，勿手改。
 *
 * 合并 PR2 起子站和主站同仓：默认直接读本仓库，不走网络。
 * 用法（在仓库根运行；<站> = blog / curio / daymark）：
 *   node scripts/<站>/sync-shell.mjs                  读本仓库工作区的主站外壳写入副本；lock 记下本仓库 HEAD 的完整提交 SHA
 *                                                    （外壳目录有未提交改动时记 worktree，--check 会要求提交后再同步一次）
 *   node scripts/<站>/sync-shell.mjs --ref <分支|提交>  改从 GitHub 上的 styrigx-space 拉（解析成完整提交 SHA 写进 lock）
 *   node scripts/<站>/sync-shell.mjs --from <目录>     从另一份主站检出读（lock 不是 SHA，--check 会要求重新同步）
 *   node scripts/<站>/sync-shell.mjs --check          CI 用：① 供应商副本没被手改（和 sgx-shell.lock.json 一致）
 *                                                    ② 副本确实来自主站：读 lock 锁定的提交上、lock 记的目录（dir）里的外壳，
 *                                                       版本和文件指纹都要和 lock 一致。本仓库有这个提交（完整克隆）就用本地 git 读，
 *                                                       不一致即失败；没有（CI 的浅克隆）才去 GitHub 拉，拉不到只提示、不算失败（加 --strict 则失败）
 *                                                    ③ 本仓库工作区的主站外壳比 lock 新时只打 ::notice::，不算失败
 *                                                       （升级外壳 = 显式跑一次同步、改 lock 的 PR，会改子站外观，单独提）
 *
 * 读取：先读 manifest.json，再逐个读文件并校验 sha256，全部通过才写盘。外壳目录按来源自适应：lock 记了 dir 就按它，
 * 新同步先找 web/atlas/shared/shell、没有再找 web/shared/shell（旧提交）。
 * __SITE_CONFIG__ 段是各站独有的写入位置，其余代码三站（blog / curio / daymark）一字不差。
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/* ---- __SITE_CONFIG__ ---- */
const SITE = {
  name: 'styrigx-curio',
  targets: [
    /* 色彩角色 + 顶栏材质 + 导航抽屉：写进 input.css 的 @sgx-shell:begin / end 两行之间（Tailwind 编进 main.css） */
    { path: 'web/assets/css/input.css', kind: 'splice', parts: ['tokens.css', 'shell.css'] },
    /* 自定义主题色引擎（js/sgx/shell-accent.js 打包，只在 cookie 是自定义色且没有缓存时才加载） */
    { path: 'web/assets/js/sgx/shell/palette-scheme.js', kind: 'file', parts: ['palette-scheme.js'] },
    /* 原地搜索层（抽屉底栏搜索框原地变成贴键盘的底栏 + 结果层，不跳主站；js/sgx/search-host.js 打包） */
    { path: 'web/assets/js/sgx/shell/search.js', kind: 'file', parts: ['search.js'] },
    /* 顶栏右胶囊的分享按钮（管理员：生成带临时会话的短链再系统分享；访客：分享当前页；js/sgx/share-host.js 打包） */
    { path: 'web/assets/js/sgx/shell/share.js', kind: 'file', parts: ['share.js'] },
    /* 导航抽屉项 + 图标（baseof.html）、预设种子 + 引擎版本（tests/web/ui-inherit.test.mjs 核对读端预设表） */
    { path: 'web/assets/sgx-shell/nav.json', kind: 'json', parts: ['nav.json'] },
    { path: 'web/assets/sgx-shell/palettes.json', kind: 'json', parts: ['palettes.json'] },
    /* 外观 cookie（sgx-ui）读端：经典脚本 ES5，baseof.html 原样内联进 <head>（挂 window.SgxUI），ui-inherit-run.js 调 SgxUI.apply */
    { path: 'web/assets/js/sgx/shell/ui-cookie-read.js', kind: 'file', parts: ['ui-cookie-read.js'] },
    /* 契约夹具（主站写端真实产出的 cookie + 读端期望）：tests/web/ui-cookie-contract.test.mjs 逐个跑 */
    { path: 'tests/fixtures/ui-cookie-contract.json', kind: 'json', parts: ['ui-cookie-contract.json'] },
  ],
};
/* ---- /__SITE_CONFIG__ ---- */

/* 2026-11-02 并进 styrigx-space：仓库根是 REPO，本站页面包在 web/curio/、测试在 tests/curio/（下面 siteFile 把站内路径 web/… tests/… 映过去） */
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SITE_DIR = 'curio';
const siteFile = (p) => path.join(REPO, p.replace(/^web\//, 'web/' + SITE_DIR + '/').replace(/^tests\//, 'tests/' + SITE_DIR + '/'));
const UPSTREAM = 'styrigx/styrigx-space';
/** 主站外壳目录：新的在前（合并 PR1 起），旧提交上是 web/shared/shell */
export const SHELL_DIRS = Object.freeze(['web/atlas/shared/shell', 'web/shared/shell']);
const LEGACY_DIR = SHELL_DIRS[1];
const LOCK = path.join(REPO, 'web', SITE_DIR, 'sgx-shell.lock.json');
const SELF = `node scripts/${SITE_DIR}/sync-shell.mjs`;
export const BEGIN = '/* @sgx-shell:begin';
export const END = '/* @sgx-shell:end */';

const sha = (s) => createHash('sha256').update(s).digest('hex');
const isSha = (s) => /^[0-9a-f]{40}$/.test(String(s));

/** 本仓库的 git（读不到 / 不是 git 仓库时抛错，调用方兜底） */
function git(args) {
  return execFileSync('git', ['-C', REPO, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024 });
}
/** 本仓库里有没有这个提交（CI 是 depth 1 的浅克隆，旧提交通常没有） */
export function hasLocalCommit(ref) {
  if (!isSha(ref)) return false;
  try { git(['cat-file', '-e', ref + '^{commit}']); return true; } catch { return false; }
}

function args(argv) {
  const o = { ref: 'main', from: REPO, check: false, strict: false, refGiven: false, fromGiven: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--check') o.check = true;
    else if (a === '--strict') o.strict = true;
    else if (a === '--ref') { o.ref = argv[++i]; o.refGiven = true; }
    else if (a === '--from') { o.from = argv[++i]; o.fromGiven = true; }
    else throw new Error('未知参数 ' + a);
  }
  /* --ref 不带 --from：从 GitHub 拉 */
  if (o.refGiven && !o.fromGiven) o.from = '';
  return o;
}

/**
 * 读主站外壳目录里的一个文件。来源三选一：o.commit（本仓库 git 里的某个提交）、o.from（目录）、GitHub（o.ref）。
 * @returns {Promise<{status:number, text:string}>}
 */
async function getUpstream(o, dir, name) {
  if (o.commit) {
    try { return { status: 200, text: git(['show', `${o.commit}:${dir}/${name}`]) }; } catch { return { status: 404, text: '' }; }
  }
  if (o.from) {
    const p = path.resolve(o.from, dir, name);
    return existsSync(p) ? { status: 200, text: readFileSync(p, 'utf8') } : { status: 404, text: '' };
  }
  const url = `https://raw.githubusercontent.com/${UPSTREAM}/${encodeURIComponent(o.ref).replace(/%2F/g, '/')}/${dir}/${name}`;
  const r = await fetch(url, { headers: { 'cache-control': 'no-cache' } });
  return { status: r.status, text: r.status === 200 ? await r.text() : '' };
}

/** 读 manifest + 全部文件并校验；o.dir 给了就只读它，否则按 SHELL_DIRS 先新后旧找。都没有返回 null */
export async function fetchBundle(o) {
  for (const dir of o.dir ? [o.dir] : SHELL_DIRS) {
    const m = await getUpstream(o, dir, 'manifest.json');
    if (m.status === 404) continue;
    if (m.status !== 200) throw new Error(`读取 ${dir}/manifest.json 失败：HTTP ${m.status}`);
    const manifest = JSON.parse(m.text);
    const files = { 'manifest.json': m.text };
    for (const [name, h] of Object.entries(manifest.files)) {
      const r = await getUpstream(o, dir, name);
      if (r.status !== 200) throw new Error(`读取 ${dir}/${name} 失败：HTTP ${r.status}`);
      if (sha(r.text) !== h) throw new Error(`${dir}/${name} 的 sha256 和 manifest 不一致（主站生成物过期？）`);
      files[name] = r.text;
    }
    return { manifest, files, dir };
  }
  return null;
}

/** 标记段内容（不含首尾标记行） */
function blockBody(parts, files) {
  return parts.map((n) => `/* ---- ${n} ---- */\n` + files[n].replace(/\n$/, '')).join('\n');
}
function beginLine(label, manifest, dir) {
  return `${BEGIN} ${UPSTREAM}@${label} ${dir} v${manifest.version}（scripts/${SITE_DIR}/sync-shell.mjs 写入，勿手改） */`;
}

/** 文件里标记段之间的内容（不含标记行）；没有标记返回 null */
export function readBlock(text) {
  const a = text.indexOf(BEGIN);
  const b = text.indexOf(END);
  if (a < 0 || b < a) return null;
  const s = text.indexOf('\n', a) + 1;
  return text.slice(s, b).replace(/\n$/, '');
}

function spliceBlock(text, block) {
  const a = text.indexOf(BEGIN);
  const b = text.indexOf(END);
  if (a < 0 || b < a) throw new Error('找不到 @sgx-shell:begin / end 标记');
  return text.slice(0, a) + block + text.slice(b + END.length);
}

/** 按 SITE 配置算出每个目标文件的新内容；返回 { 相对路径: 内容 } 和 { 相对路径: 校验内容 }（bundle.dir 缺省按旧目录写标记行） */
export function renderTargets(bundle, label, current = (p) => (existsSync(siteFile(p)) ? readFileSync(siteFile(p), 'utf8') : '')) {
  const { manifest, files } = bundle;
  const dir = bundle.dir || LEGACY_DIR;
  const out = {};
  const guard = {};
  for (const t of SITE.targets) {
    const body = t.kind === 'json' ? files[t.parts[0]] : blockBody(t.parts, files);
    if (t.kind === 'json') {
      out[t.path] = body;
      guard[t.path] = body;
      continue;
    }
    const block = beginLine(label, manifest, dir) + '\n' + body + '\n' + END;
    if (t.kind === 'splice') out[t.path] = spliceBlock(current(t.path), block);
    else out[t.path] = (t.head || '') + block + '\n';
    guard[t.path] = body;
  }
  return { out, guard };
}

/** 本仓库工作区读外壳时 lock 记什么：外壳目录和 HEAD 一致 → HEAD 的完整 SHA；有未提交改动 / 读不到 git → worktree */
function localLabel(dir) {
  try {
    const head = git(['rev-parse', 'HEAD']).trim();
    const dirty = git(['status', '--porcelain', '--', dir]).trim();
    return isSha(head) && !dirty ? head : 'worktree';
  } catch {
    return 'worktree';
  }
}

async function main() {
  const o = args(process.argv);
  const sameRepo = !o.fromGiven && !o.refGiven;
  if (o.check) {
    if (!existsSync(LOCK)) { console.error(`缺少 web/${SITE_DIR}/sgx-shell.lock.json：先运行 ${SELF}`); process.exit(1); }
    const lock = JSON.parse(readFileSync(LOCK, 'utf8'));
    const bad = [];
    for (const t of SITE.targets) {
      const text = existsSync(siteFile(t.path)) ? readFileSync(siteFile(t.path), 'utf8') : '';
      const body = t.kind === 'json' ? text : readBlock(text);
      if (body === null || sha(body) !== lock.vendored[t.path]) bad.push(t.path);
    }
    if (bad.length) { console.error('共享外壳副本被手改或缺失：' + bad.join('、') + `；改主站后运行 ${SELF}`); process.exit(1); }
    /* ② 按 lock 锁定的提交、lock 记的目录核对（--ref / --from 显式给了就用给的） */
    let src;
    let where;
    let local = false;
    if (sameRepo) {
      if (!isSha(lock.ref)) {
        console.error(`web/${SITE_DIR}/sgx-shell.lock.json 的 ref（${lock.ref}）不是完整提交 SHA：提交主站外壳后运行 ${SELF} 重新同步（会锁定到当时的提交）`);
        process.exit(1);
      }
      local = hasLocalCommit(lock.ref);
      src = local ? { commit: lock.ref } : { ref: lock.ref, from: '' };
      where = `${lock.ref}（${local ? '本仓库 git' : 'GitHub'}）`;
    } else {
      src = { ref: o.ref, from: o.from };
      where = o.from ? path.resolve(o.from) : o.ref;
    }
    let up;
    /* 锁定提交按 lock 记的目录读；显式给的 --from / --ref 按来源自适应 */
    try { up = await fetchBundle({ ...src, dir: sameRepo ? lock.dir || '' : '' }); } catch (e) {
      console.error(`读取主站外壳失败（${where}）：${e.message}`);
      process.exit(o.strict || local ? 1 : 0);
    }
    if (!up) {
      const msg = `主站 ${where} 上没有 ${lock.dir || SHELL_DIRS.join(' / ')}；保留本地副本 v${lock.version}（来自 ${lock.ref}）`;
      if (o.strict || local) { console.error(msg); process.exit(1); }
      console.log('::notice::' + msg);
      return;
    }
    const sameFiles = JSON.stringify(Object.entries(up.manifest.files).sort()) === JSON.stringify(Object.entries(lock.files || {}).sort());
    if (up.manifest.version !== lock.version || !sameFiles) {
      console.error(`web/${SITE_DIR}/sgx-shell.lock.json 和主站 ${where} 上的外壳对不上：lock 记的是 v${lock.version}，那里是 v${up.manifest.version}；运行 ${SELF} 重新同步`);
      process.exit(1);
    }
    console.log(`shared shell matches the pinned main-site commit: v${lock.version} (${where} ${up.dir})`);
    /* ③ 只提示：本仓库工作区的主站外壳更新了（升级要显式同步，不让无关 PR 变红） */
    if (sameRepo) {
      try {
        const cur = await fetchBundle({ from: REPO, dir: SHELL_DIRS[0] });
        if (cur && cur.manifest.version !== lock.version) {
          console.log(`::notice::本仓库主站的共享外壳是 v${cur.manifest.version}（${SITE_DIR} 锁定 v${lock.version}）；要升级就运行 ${SELF} 并提交`);
        }
      } catch { /* 只是提示，读不到就算了 */ }
    }
    return;
  }
  /* 同仓：读工作区；GitHub：先把 ref 解析成完整提交 SHA，lock 锁定到这个提交，--check 只和它比 */
  let label = o.ref;
  let src = { from: o.from, ref: o.ref };
  if (sameRepo) {
    const probe = await fetchBundle({ from: REPO });
    label = probe ? localLabel(probe.dir) : 'worktree';
  } else if (o.from) {
    label = `${o.ref}（本地 ${path.basename(path.resolve(o.from))}）`;
  } else if (!isSha(o.ref)) {
    const r = await fetch(`https://api.github.com/repos/${UPSTREAM}/commits/${encodeURIComponent(o.ref)}`, { headers: { accept: 'application/vnd.github.sha' } });
    const s = (await r.text()).trim();
    if (r.status !== 200 || !isSha(s)) throw new Error(`解析主站 ${o.ref} 的提交 SHA 失败：HTTP ${r.status}`);
    label = s;
    src = { from: '', ref: s };
  }
  const bundle = await fetchBundle(src);
  if (!bundle) { console.error(`主站 ${o.from ? path.resolve(o.from) : UPSTREAM + '@' + src.ref} 上没有 ${SHELL_DIRS.join(' / ')}`); process.exit(1); }
  const { out, guard } = renderTargets(bundle, label);
  for (const [p, text] of Object.entries(out)) {
    mkdirSync(path.dirname(siteFile(p)), { recursive: true });
    writeFileSync(siteFile(p), text);
  }
  const lock = {
    _note: `scripts/${SITE_DIR}/sync-shell.mjs 写入，勿手改：记录本站的共享外壳副本来自主站哪个版本`,
    source: UPSTREAM,
    dir: bundle.dir,
    ref: label,
    version: bundle.manifest.version,
    files: bundle.manifest.files,
    vendored: Object.fromEntries(Object.entries(guard).map(([p, b]) => [p, sha(b)])),
  };
  writeFileSync(LOCK, JSON.stringify(lock, null, 2) + '\n');
  console.log(`shared shell v${bundle.manifest.version} ← ${UPSTREAM}@${label} ${bundle.dir}：` + Object.keys(out).join(', '));
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) main().catch((e) => { console.error(e.message || e); process.exit(1); });
