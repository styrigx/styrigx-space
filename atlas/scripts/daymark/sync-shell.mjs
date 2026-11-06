#!/usr/bin/env node
/**
 * 同步主站共享外壳（本仓库 styrigx/styrigx-space 的 space/web/shared/shell；2026-11-06 分包之前在 web/atlas/shared/shell，2026-11-02 合并 PR1 之前在 web/shared/shell）：
 * 色彩角色、顶栏材质、导航抽屉、自定义主题色引擎、抽屉项。主站是唯一来源；本站只存一份「供应商副本」，放在标记段 / 供应商目录里，勿手改。
 *
 * 合并 PR2 起子站和主站同仓：默认直接读本仓库，不走网络。
 * 合并 PR3 起 lock 锁外壳目录的 git tree 哈希（tree 字段，和 `git rev-parse <提交>:<外壳目录>` 同值），不再锁提交 SHA：
 * PR 分支上的提交 squash 合并后就不存在了，而 tree 只由外壳内容决定，合并方式、目录挪动（dir 只作记录）都不影响它。
 * 旧格式 lock（只有 ref = 提交 SHA）照样能读：--check 用本地 git 把它换算成 tree 核对；--migrate-lock 只把 lock 改写成新格式。
 * 用法（在仓库根运行；<站> = blog / curio / daymark）：
 *   node atlas/scripts/<站>/sync-shell.mjs                  读本仓库工作区的主站外壳写入副本；lock 记下外壳内容的 tree 哈希
 *                                                    （外壳目录有未提交改动也照算；没提交前 --check 在本仓库里找不到这个 tree 会失败，提交后即通过）
 *   node atlas/scripts/<站>/sync-shell.mjs --ref <分支|提交>  改从 GitHub 上的 styrigx-space 拉（tree 按拉到的内容算）
 *   node atlas/scripts/<站>/sync-shell.mjs --from <目录>     从另一份主站检出读（tree 按读到的内容算）
 *   node atlas/scripts/<站>/sync-shell.mjs --migrate-lock   只迁移 lock 格式（旧 ref → tree），不碰副本、不改外壳内容；需要本仓库有旧 ref 那个提交
 *   node atlas/scripts/<站>/sync-shell.mjs --check          CI 用：① 供应商副本没被手改（和 sgx-shell.lock.json 一致）
 *                                                    ② 副本确实来自主站：用本地 git 读 lock 锁定的 tree，版本、文件指纹、tree 哈希都要和 lock 一致，
 *                                                       不一致即失败；本仓库取不到这个 tree 时：浅克隆 / 不是 git 仓库只打 ::notice::、不算失败
 *                                                       （加 --strict 则失败），完整克隆里也没有 = 外壳没提交过或 lock 被手改，失败
 *                                                    ③ 本仓库工作区的主站外壳比 lock 新时只打 ::notice::，不算失败
 *                                                       （升级外壳 = 显式跑一次同步、改 lock 的 PR，会改子站外观，单独提）
 *
 * 读取：先读 manifest.json，再逐个读文件并校验 sha256，全部通过才写盘。外壳目录按来源自适应：lock 记了 dir 就按它，
 * 新同步按 SHELL_DIRS 先新后旧找（space/web/shared/shell → 旧提交上的 web/atlas/shared/shell、web/shared/shell）。
 * __SITE_CONFIG__ 段是各站独有的写入位置，其余代码三站（blog / curio / daymark）一字不差。
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/* ---- __SITE_CONFIG__ ---- */
const SITE = {
  name: 'styrigx-daymark',
  targets: [
    /* 色彩角色 + 顶栏 + 快捷面板 / AI 窗口：写进 input.css 的 @sgx-shell:begin / end 两行之间（Tailwind 编进 main.css） */
    { path: 'web/assets/css/input.css', kind: 'splice', parts: ['tokens.css', 'shell.css'] },
    /* 自定义主题色引擎（js/sgx/shell-accent.js 打包，只在 cookie 是自定义色且没有缓存时才加载） */
    { path: 'web/assets/js/sgx/shell/palette-scheme.js', kind: 'file', parts: ['palette-scheme.js'] },
    /* 快捷面板「分享本页」磁贴（2026-11-04 P5-1 起；进门的人都一样：锁侧复验后生成带临时会话的短链再系统分享；js/sgx/share-host.js 打包） */
    { path: 'web/assets/js/sgx/shell/share.js', kind: 'file', parts: ['share.js'] },
    /* 顶栏 + 快捷面板 + AI 窗口的标记（Hugo partial，原样，kind raw：不加注释头；2026-11-04 P5-1 四站同一个顶栏） */
    { path: 'web/layouts/partials/sgx-shell-topbar.html', kind: 'raw', parts: ['topbar.html'] },
    /* 顶栏两个窗口的开合 / 互斥 / 两页 / 磁贴、状态机、AI 窗口内容、外观写端（入口脚本把后三个传给 topbar.js 的 mountTopbar） */
    { path: 'web/assets/js/sgx/shell/topbar.js', kind: 'file', parts: ['topbar.js'] },
    { path: 'web/assets/js/sgx/shell/modal-sheet.js', kind: 'file', parts: ['modal-sheet.js'] },
    { path: 'web/assets/js/sgx/shell/ai.js', kind: 'file', parts: ['ai.js'] },
    { path: 'web/assets/js/sgx/shell/prefs-write.js', kind: 'file', parts: ['prefs-write.js'] },
    /* 快捷面板导航项 + 图标（baseof.html）、预设种子 + 引擎版本（tests/daymark/ui-inherit.test.mjs 核对读端预设表） */
    { path: 'web/assets/sgx-shell/nav.json', kind: 'json', parts: ['nav.json'] },
    { path: 'web/assets/sgx-shell/palettes.json', kind: 'json', parts: ['palettes.json'] },
    /* 外观 cookie（sgx-ui）读端：经典脚本 ES5，baseof.html 原样内联进 <head>（挂 window.SgxUI），ui-inherit-run.js 调 SgxUI.apply */
    { path: 'web/assets/js/sgx/shell/ui-cookie-read.js', kind: 'file', parts: ['ui-cookie-read.js'] },
    /* ui-cookie-contract.json（契约夹具）不再同步副本：2026-11-06 tests/ 结构统一起子站单测 / e2e 直接读仓库共享的 tests/fixtures/ui-cookie-contract.json（gen-ui-cookie-contract.mjs 生成，--check 守着）；外壳目录里那份仍在 lock 的 files 指纹里 */
  ],
};
/* ---- /__SITE_CONFIG__ ---- */

/* 2026-11-02 并进 styrigx-space：仓库根是 REPO，本站页面包在 atlas/web/daymark/、测试在 tests/daymark/（下面 siteFile 把站内路径 web/… tests/… 映到 atlas/web/daymark/… tests/daymark/…） */
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const SITE_DIR = 'daymark';
const siteFile = (p) => path.join(REPO, p.replace(/^web\//, 'atlas/web/' + SITE_DIR + '/').replace(/^tests\//, 'tests/' + SITE_DIR + '/'));
const UPSTREAM = 'styrigx/styrigx-space';
/** 主站外壳目录：新的在前。2026-11-06 分包起在 space/web/shared/shell；旧提交上是 web/atlas/shared/shell（合并 PR1 起）、web/shared/shell（更早） */
export const SHELL_DIRS = Object.freeze(['space/web/shared/shell', 'web/atlas/shared/shell', 'web/shared/shell']);
const LEGACY_DIR = SHELL_DIRS[2];
const LOCK = path.join(REPO, 'atlas', 'web', SITE_DIR, 'sgx-shell.lock.json');
const SELF = `node atlas/scripts/${SITE_DIR}/sync-shell.mjs`;
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
/** 本仓库里有没有这个 tree 对象（浅克隆只有 HEAD 那一层的 tree） */
export function hasLocalTree(tree) {
  if (!isSha(tree)) return false;
  try { git(['cat-file', '-e', tree + '^{tree}']); return true; } catch { return false; }
}
/** 本仓库是不是浅克隆；不是 git 仓库 / 读不到返回 null */
function shallowState() {
  try { return git(['rev-parse', '--is-shallow-repository']).trim() === 'true'; } catch { return null; }
}

/**
 * 平铺目录（只有普通文件、没有子目录）的 git tree 哈希，和 `git rev-parse <提交>:<目录>` 同值。
 * files = { 文件名: 文本 }；外壳目录就是 manifest.json + manifest 列出的文件，平铺、100644。
 */
export function gitTreeHash(files) {
  const names = Object.keys(files).sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
  const body = Buffer.concat(names.map((name) => {
    const buf = Buffer.from(files[name], 'utf8');
    const blob = createHash('sha1').update(`blob ${buf.length}\0`).update(buf).digest();
    return Buffer.concat([Buffer.from(`100644 ${name}\0`), blob]);
  }));
  return createHash('sha1').update(`tree ${body.length}\0`).update(body).digest('hex');
}

/**
 * lock 锁定的 tree：新格式直接读 tree 字段；旧格式（只有 ref = 提交 SHA）在本仓库有这个提交时换算成 <ref>:<dir> 的 tree。
 * @returns {{tree:string|null, legacy:boolean, reason?:string}}
 */
export function pinnedTree(lock) {
  if (isSha(lock.tree)) return { tree: lock.tree, legacy: false };
  if (!isSha(lock.ref)) return { tree: null, legacy: true, reason: `既没有 tree 也没有提交 SHA（ref = ${lock.ref}）` };
  if (!hasLocalCommit(lock.ref)) return { tree: null, legacy: true, reason: `旧格式 lock 锁的提交 ${lock.ref} 不在本仓库` };
  try {
    return { tree: git(['rev-parse', `${lock.ref}:${lock.dir || LEGACY_DIR}`]).trim(), legacy: true };
  } catch {
    return { tree: null, legacy: true, reason: `提交 ${lock.ref} 上没有 ${lock.dir || LEGACY_DIR}` };
  }
}

function args(argv) {
  const o = { ref: 'main', from: REPO, check: false, strict: false, migrate: false, refGiven: false, fromGiven: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--check') o.check = true;
    else if (a === '--strict') o.strict = true;
    else if (a === '--migrate-lock') o.migrate = true;
    else if (a === '--ref') { o.ref = argv[++i]; o.refGiven = true; }
    else if (a === '--from') { o.from = argv[++i]; o.fromGiven = true; }
    else throw new Error('未知参数 ' + a);
  }
  /* --ref 不带 --from：从 GitHub 拉 */
  if (o.refGiven && !o.fromGiven) o.from = '';
  return o;
}

/**
 * 读主站外壳目录里的一个文件。来源四选一：o.tree（本仓库 git 里的 tree 对象，文件名相对它）、o.commit（本仓库 git 里的某个提交）、
 * o.from（目录）、GitHub（o.ref）。
 * @returns {Promise<{status:number, text:string}>}
 */
async function getUpstream(o, dir, name) {
  if (o.tree) {
    try { return { status: 200, text: git(['show', `${o.tree}:${name}`]) }; } catch { return { status: 404, text: '' }; }
  }
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

/**
 * 读 manifest + 全部文件并校验；o.dir 给了就只读它，否则按 SHELL_DIRS 先新后旧找。都没有返回 null。
 * 返回的 tree 是按读到的内容算的 git tree 哈希（manifest.json + manifest 列出的文件）。
 */
export async function fetchBundle(o) {
  for (const dir of o.dir ? [o.dir] : o.tree ? [LEGACY_DIR] : SHELL_DIRS) {
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
    return { manifest, files, dir, tree: gitTreeHash(files) };
  }
  return null;
}

/** 标记段内容（不含首尾标记行） */
function blockBody(parts, files) {
  return parts.map((n) => `/* ---- ${n} ---- */\n` + files[n].replace(/\n$/, '')).join('\n');
}
function beginLine(label, manifest, dir) {
  return `${BEGIN} ${UPSTREAM}@${label} ${dir} v${manifest.version}（space/scripts/${SITE_DIR}/sync-shell.mjs 写入，勿手改） */`;
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
    const raw = t.kind === 'json' || t.kind === 'raw';
    const body = raw ? files[t.parts[0]] : blockBody(t.parts, files);
    if (raw) {
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

/**
 * 新格式 lock（字段顺序固定）。tree 是唯一的锁定依据；from 只记这次是从哪同步的（提交 SHA / worktree / 分支），
 * 可能在 squash 合并后不存在，--check 不用它。
 */
export function lockObject({ dir, tree, from, version, files, vendored }) {
  return {
    _note: `space/scripts/${SITE_DIR}/sync-shell.mjs 写入，勿手改：tree 是本站共享外壳副本对应的主站外壳目录（dir）的 git tree 哈希；from 只作记录`,
    source: UPSTREAM,
    dir,
    tree,
    from,
    version,
    files,
    vendored,
  };
}

/** 本仓库工作区读外壳时 from 记什么：外壳目录和 HEAD 一致 → HEAD 的完整 SHA；有未提交改动 / 读不到 git → worktree */
function localLabel(dir) {
  try {
    const head = git(['rev-parse', 'HEAD']).trim();
    const dirty = git(['status', '--porcelain', '--', dir]).trim();
    return isSha(head) && !dirty ? head : 'worktree';
  } catch {
    return 'worktree';
  }
}

/** 本地 git 读 lock 锁定的 tree，核对版本、文件指纹、tree 哈希；返回错误说明，一致返回 '' */
export async function verifyTree(lock, tree) {
  const up = await fetchBundle({ tree, dir: lock.dir || LEGACY_DIR });
  if (!up) return `tree ${tree} 里没有 manifest.json`;
  const sameFiles = JSON.stringify(Object.entries(up.manifest.files).sort()) === JSON.stringify(Object.entries(lock.files || {}).sort());
  if (up.manifest.version !== lock.version || !sameFiles) return `lock 记的是 v${lock.version}，tree ${tree} 里是 v${up.manifest.version}${sameFiles ? '' : '（文件指纹也不同）'}`;
  if (up.tree !== tree) return `tree ${tree} 里有 manifest 之外的文件（按 manifest 算出的 tree 是 ${up.tree}）`;
  return '';
}

async function main() {
  const o = args(process.argv);
  const sameRepo = !o.fromGiven && !o.refGiven;
  const lockRel = `atlas/web/${SITE_DIR}/sgx-shell.lock.json`;
  if (o.migrate) {
    if (!existsSync(LOCK)) { console.error(`缺少 ${lockRel}`); process.exit(1); }
    const lock = JSON.parse(readFileSync(LOCK, 'utf8'));
    const pin = pinnedTree(lock);
    if (!pin.tree) { console.error(`${lockRel} 迁移不了：${pin.reason}（需要完整克隆）`); process.exit(1); }
    const err = await verifyTree(lock, pin.tree);
    if (err) { console.error(`${lockRel} 迁移不了：${err}`); process.exit(1); }
    const next = lockObject({ dir: lock.dir || LEGACY_DIR, tree: pin.tree, from: lock.from || lock.ref, version: lock.version, files: lock.files, vendored: lock.vendored });
    writeFileSync(LOCK, JSON.stringify(next, null, 2) + '\n');
    console.log(`${lockRel}: ${pin.legacy ? `ref ${lock.ref} → ` : ''}tree ${pin.tree}（v${lock.version}，副本未动）`);
    return;
  }
  if (o.check) {
    if (!existsSync(LOCK)) { console.error(`缺少 ${lockRel}：先运行 ${SELF}`); process.exit(1); }
    const lock = JSON.parse(readFileSync(LOCK, 'utf8'));
    const bad = [];
    for (const t of SITE.targets) {
      const text = existsSync(siteFile(t.path)) ? readFileSync(siteFile(t.path), 'utf8') : '';
      const body = t.kind === 'json' || t.kind === 'raw' ? text : readBlock(text);
      if (body === null || sha(body) !== lock.vendored[t.path]) bad.push(t.path);
    }
    if (bad.length) { console.error('共享外壳副本被手改或缺失：' + bad.join('、') + `；改主站后运行 ${SELF}`); process.exit(1); }
    if (sameRepo) {
      /* ② 按 lock 锁定的 tree 用本地 git 核对，不走网络 */
      const pin = pinnedTree(lock);
      if (pin.legacy) console.log(`::notice::${lockRel} 还是旧格式（锁提交 SHA）；运行 ${SELF} --migrate-lock 改成锁 tree（不改副本）`);
      if (!pin.tree && !isSha(lock.ref)) { console.error(`${lockRel} ${pin.reason}：运行 ${SELF} 重新同步`); process.exit(1); }
      const tree = pin.tree;
      if (!tree || !hasLocalTree(tree)) {
        const shallow = shallowState();
        const what = tree ? `tree ${tree}` : pin.reason;
        if (shallow !== false) {
          const msg = `本仓库取不到 ${what}（${shallow ? '浅克隆，没有那段历史' : '不是 git 仓库'}），跳过来源核对；副本指纹已核对 v${lock.version}。要复核：git fetch --unshallow 后再跑 ${SELF} --check`;
          if (o.strict) { console.error(msg); process.exit(1); }
          console.log('::notice::' + msg);
          return;
        }
        console.error(`完整克隆里找不到 ${what}：主站外壳没有提交过，或 ${lockRel} 被手改；提交主站外壳后运行 ${SELF} 重新同步`);
        process.exit(1);
      }
      let err;
      try { err = await verifyTree(lock, tree); } catch (e) { err = e.message; }
      if (err) { console.error(`${lockRel} 和锁定的主站外壳对不上：${err}；运行 ${SELF} 重新同步`); process.exit(1); }
      console.log(`shared shell matches the pinned main-site tree: v${lock.version} (tree ${tree}，本仓库 git)`);
      /* ③ 只提示：本仓库工作区的主站外壳更新了（升级要显式同步，不让无关 PR 变红） */
      try {
        const cur = await fetchBundle({ from: REPO, dir: SHELL_DIRS[0] });
        if (cur && cur.tree !== tree) {
          console.log(`::notice::本仓库主站的共享外壳是 v${cur.manifest.version}（${SITE_DIR} 锁定 v${lock.version}）；要升级就运行 ${SELF} 并提交`);
        }
      } catch { /* 只是提示，读不到就算了 */ }
      return;
    }
    /* 显式给了 --from / --ref：和给的来源比（按来源自适应目录）；有 tree 时 tree 也要一致 */
    const where = o.from ? path.resolve(o.from) : o.ref;
    let up;
    try { up = await fetchBundle({ ref: o.ref, from: o.from }); } catch (e) {
      console.error(`读取主站外壳失败（${where}）：${e.message}`);
      process.exit(o.strict ? 1 : 0);
    }
    if (!up) {
      const msg = `主站 ${where} 上没有 ${SHELL_DIRS.join(' / ')}；保留本地副本 v${lock.version}`;
      if (o.strict) { console.error(msg); process.exit(1); }
      console.log('::notice::' + msg);
      return;
    }
    const sameFiles = JSON.stringify(Object.entries(up.manifest.files).sort()) === JSON.stringify(Object.entries(lock.files || {}).sort());
    if (up.manifest.version !== lock.version || !sameFiles || (isSha(lock.tree) && up.tree !== lock.tree)) {
      console.error(`${lockRel} 和主站 ${where} 上的外壳对不上：lock 记的是 v${lock.version}，那里是 v${up.manifest.version}；运行 ${SELF} 重新同步`);
      process.exit(1);
    }
    console.log(`shared shell matches main-site ${where}: v${lock.version} (${up.dir} tree ${up.tree})`);
    return;
  }
  /* 同仓：读工作区；GitHub：先把 ref 解析成完整提交 SHA 再拉（from 记下它），lock 锁按内容算出的 tree */
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
  /* 同仓且外壳已提交：按内容算的 tree 必须和 git 里的一致（不一致 = 目录里有 manifest 之外的文件） */
  if (sameRepo && isSha(label)) {
    let gitTree = '';
    try { gitTree = git(['rev-parse', `${label}:${bundle.dir}`]).trim(); } catch { /* 读不到就不比 */ }
    if (gitTree && gitTree !== bundle.tree) throw new Error(`${bundle.dir} 里有 manifest 之外的文件：git tree ${gitTree}，按 manifest 算出 ${bundle.tree}；先跑 node space/scripts/gen-shell.mjs`);
  }
  const { out, guard } = renderTargets(bundle, `tree:${bundle.tree.slice(0, 12)}`);
  for (const [p, text] of Object.entries(out)) {
    mkdirSync(path.dirname(siteFile(p)), { recursive: true });
    writeFileSync(siteFile(p), text);
  }
  const lock = lockObject({
    dir: bundle.dir,
    tree: bundle.tree,
    from: label,
    version: bundle.manifest.version,
    files: bundle.manifest.files,
    vendored: Object.fromEntries(Object.entries(guard).map(([p, b]) => [p, sha(b)])),
  });
  writeFileSync(LOCK, JSON.stringify(lock, null, 2) + '\n');
  console.log(`shared shell v${bundle.manifest.version} ← ${UPSTREAM}@${label} ${bundle.dir} (tree ${bundle.tree})：` + Object.keys(out).join(', '));
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) main().catch((e) => { console.error(e.message || e); process.exit(1); });
