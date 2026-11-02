/**
 * 子站 sync-shell 同仓读取（合并 PR2）：scripts/<站>/sync-shell.mjs 默认读本仓库的 web/atlas/shared/shell，不走网络；
 * 外壳目录按来源自适应（lock 记的 dir；新同步先新目录 web/atlas/shared/shell、再旧目录 web/shared/shell）；
 * --check 时锁定提交在本仓库里就用本地 git 读（CI 浅克隆没有才去 GitHub）。三份脚本除 __SITE_CONFIG__ 段和 SITE_DIR 外一字不差。
 * 运行：node --test tests/web/ui/sync-shell-same-repo.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

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

test('各站 lock：ref 是完整提交 SHA，dir 是两个外壳目录之一；锁定提交在本仓库里时，本地 git 读出的外壳和 lock 一致', async (t) => {
  for (const s of SITES) {
    const { SHELL_DIRS, fetchBundle, hasLocalCommit } = await load(s);
    const lock = lockOf(s);
    assert.match(lock.ref, /^[0-9a-f]{40}$/, s);
    assert.ok(SHELL_DIRS.includes(lock.dir), s + ' dir=' + lock.dir);
    if (!hasLocalCommit(lock.ref)) { t.diagnostic(`${s}: ${lock.ref} 不在本仓库（浅克隆），跳过本地 git 核对`); continue; }
    const b = await fetchBundle({ commit: lock.ref, dir: lock.dir });
    assert.ok(b, s);
    assert.equal(b.manifest.version, lock.version, s);
    assert.deepEqual(Object.entries(b.manifest.files).sort(), Object.entries(lock.files).sort(), s);
  }
});
