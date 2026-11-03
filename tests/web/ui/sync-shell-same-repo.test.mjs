/**
 * 子站 sync-shell 同仓读取（合并 PR2）：scripts/<站>/sync-shell.mjs 默认读本仓库的 web/atlas/shared/shell，不走网络；
 * 外壳目录按来源自适应（lock 记的 dir；新同步先新目录 web/atlas/shared/shell、再旧目录 web/shared/shell）；
 * 合并 PR3 起 lock 锁外壳目录的 git tree 哈希（squash 合并后提交没了 tree 还在），--check 用本地 git 读这个 tree，
 * 取不到（CI 浅克隆）只提示不算失败；旧格式（ref = 提交 SHA）仍可读。三份脚本除 __SITE_CONFIG__ 段和 SITE_DIR 外一字不差。
 * 运行：node --test tests/web/ui/sync-shell-same-repo.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const SITES = ['blog', 'curio', 'daymark'];
const load = (s) => import(pathToFileURL(path.join(REPO, 'scripts', s, 'sync-shell.mjs')).href);
const lockOf = (s) => JSON.parse(readFileSync(path.join(REPO, 'web', s, 'sgx-shell.lock.json'), 'utf8'));

test('三份 sync-shell.mjs 除站点配置外一字不差', () => {
  const strip = (s) => readFileSync(path.join(REPO, 'scripts', s, 'sync-shell.mjs'), 'utf8')
    .replace(/\/\* ---- __SITE_CONFIG__ ---- \*\/[\s\S]*?\/\* ---- \/__SITE_CONFIG__ ---- \*\//, '')
    .replace(/web\/(blog|curio|daymark)\//g, 'web/<站>/').replace(/tests\/(blog|curio|daymark)\//g, 'tests/<站>/')
    .replace(/const SITE_DIR = '(blog|curio|daymark)';/, '');
  const [a, ...rest] = SITES.map(strip);
  for (const b of rest) assert.equal(b, a);
});

test('外壳目录：新的在前，旧提交上的 web/shared/shell 在后；默认读本仓库工作区的新目录', async () => {
  const { SHELL_DIRS, fetchBundle } = await load('curio');
  assert.deepEqual([...SHELL_DIRS], ['web/atlas/shared/shell', 'web/shared/shell']);
  const b = await fetchBundle({ from: REPO });
  assert.equal(b.dir, 'web/atlas/shared/shell');
  assert.equal(b.manifest.version, JSON.parse(readFileSync(path.join(REPO, 'web/atlas/shared/shell/manifest.json'), 'utf8')).version);
});

const gitOut = (...a) => execFileSync('git', ['-C', REPO, ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
const isFullClone = () => { try { return gitOut('rev-parse', '--is-shallow-repository') === 'false'; } catch { return false; } };

test('gitTreeHash：按内容算出的 tree 和 git rev-parse HEAD:web/atlas/shared/shell 一致（工作区外壳未改动时）', async (t) => {
  const { gitTreeHash, fetchBundle } = await load('blog');
  let head;
  try { head = gitOut('rev-parse', 'HEAD:web/atlas/shared/shell'); } catch { t.skip('不是 git 仓库'); return; }
  if (gitOut('status', '--porcelain', '--', 'web/atlas/shared/shell')) { t.skip('外壳目录有未提交改动'); return; }
  const b = await fetchBundle({ from: REPO, dir: 'web/atlas/shared/shell' });
  assert.equal(gitTreeHash(b.files), head);
  assert.equal(b.tree, head);
  /* 排序按字节、和插入顺序无关 */
  const rev = Object.fromEntries(Object.entries(b.files).reverse());
  assert.equal(gitTreeHash(rev), head);
});

test('各站 lock：tree 是 40 位哈希，dir 是两个外壳目录之一，不再有 ref；tree 在本仓库里时本地 git 读出的外壳和 lock 一致', async (t) => {
  for (const s of SITES) {
    const { SHELL_DIRS, hasLocalTree, verifyTree, fetchBundle } = await load(s);
    const lock = lockOf(s);
    assert.match(lock.tree, /^[0-9a-f]{40}$/, s);
    assert.equal(lock.ref, undefined, s);
    assert.ok(SHELL_DIRS.includes(lock.dir), s + ' dir=' + lock.dir);
    if (!hasLocalTree(lock.tree)) { t.diagnostic(`${s}: tree ${lock.tree} 不在本仓库（浅克隆），跳过本地 git 核对`); continue; }
    assert.equal(await verifyTree(lock, lock.tree), '', s);
    const b = await fetchBundle({ tree: lock.tree, dir: lock.dir });
    assert.equal(b.tree, lock.tree, s);
    assert.equal(b.manifest.version, lock.version, s);
  }
});

test('verifyTree：tree 对不上版本 / 文件指纹时给出说明', async (t) => {
  const { verifyTree, hasLocalTree } = await load('curio');
  const lock = lockOf('curio');
  let cur;
  try { cur = gitOut('rev-parse', 'HEAD:web/atlas/shared/shell'); } catch { t.skip('不是 git 仓库'); return; }
  if (cur === lock.tree || !hasLocalTree(cur)) { t.skip('当前外壳就是锁定的那份'); return; }
  assert.match(await verifyTree(lock, cur), /lock 记的是 v/);
});

test('pinnedTree：新格式直接用 tree；旧格式（ref = 提交 SHA）在本地有提交时换算成 <ref>:<dir> 的 tree，没有时说明原因', async (t) => {
  const { pinnedTree, hasLocalTree } = await load('daymark');
  const lock = lockOf('daymark');
  assert.deepEqual(pinnedTree(lock), { tree: lock.tree, legacy: false });
  const missing = pinnedTree({ ref: '0'.repeat(40), dir: lock.dir });
  assert.equal(missing.tree, null);
  assert.match(missing.reason, /不在本仓库/);
  assert.match(pinnedTree({ ref: 'worktree' }).reason, /既没有 tree/);
  assert.equal(hasLocalTree('0'.repeat(40)), false);
  if (!isFullClone()) { t.diagnostic('浅克隆：跳过旧格式换算'); return; }
  /* 用 HEAD 当旧格式 ref：换算结果必须等于 git rev-parse HEAD:<dir> */
  const head = gitOut('rev-parse', 'HEAD');
  const legacy = pinnedTree({ ref: head, dir: 'web/atlas/shared/shell' });
  assert.equal(legacy.legacy, true);
  assert.equal(legacy.tree, gitOut('rev-parse', 'HEAD:web/atlas/shared/shell'));
});

test('lockObject：字段顺序固定，tree 在前、from 只作记录', async () => {
  const { lockObject } = await load('blog');
  const l = lockObject({ dir: 'd', tree: 't', from: 'f', version: 'v', files: {}, vendored: {} });
  assert.deepEqual(Object.keys(l), ['_note', 'source', 'dir', 'tree', 'from', 'version', 'files', 'vendored']);
});

test('--check：三站在本仓库都通过（完整克隆核对 tree；浅克隆只提示不算失败）', () => {
  for (const s of SITES) {
    const r = spawnSync(process.execPath, [path.join(REPO, 'scripts', s, 'sync-shell.mjs'), '--check'], { cwd: REPO, encoding: 'utf8' });
    assert.equal(r.status, 0, s + ': ' + r.stderr);
    assert.match(r.stdout, /matches the pinned main-site tree|::notice::本仓库取不到/, s);
  }
});
