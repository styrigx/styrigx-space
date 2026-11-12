/**
 * 终端统一 T1（设计稿 v1.5 §4）：公共件 shell/term/core/*.js 只有一份，宿主只转出；gen-shell 对 terminal.js、ai-panel.js 只放宽到 shell/term/**。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkTermImports } from '../../../../space/scripts/gen-shell.mjs';
import * as S from '../../../../space/web/assets/shell/js/shell/term/core/strings.js';
import * as P from '../../../../space/web/assets/shell/js/shell/term/core/parse.js';
import * as KH from '../../../../space/web/assets/shell/js/shell/term/view/keyhint.js';
import * as AC from '../../../../space/web/assets/shell/js/shell/account/commands.js';
import * as T from '../../../../space/web/assets/shell/js/shell/terminal.js';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const read = (f) => readFileSync(path.join(REPO, f), 'utf8');

test('宿主转出的是同一份（同一个引用）', async () => {
  assert.equal(KH.KH_EN, S.KH_EN);
  assert.equal(AC.normCmd, P.normCmd);
  /* v6 P4：旧命令字 sudo styrigx / sudo root 和旧环境提示符 root@account 删了 */
  for (const k of ['ADMIN_COMMAND', 'ROOT_COMMAND', 'ENV_GUEST', 'ENV_ROOT']) assert.equal(/** @type {any} */ (P)[k], undefined, k);
  assert.equal(/** @type {any} */ (AC).ROOT_COMMAND, undefined);
  /* v5 S5：一个终端，身份 / 提示符只在 term/core/who.js；terminal.js 转出同一个 createWho */
  assert.equal(typeof T.createWho, 'function');
});

test('没有残留的抄写：flatStrings / normCmd / lev 只定义在 term/core', () => {
  const files = ['terminal.js', 'ai-panel.js', 'term/view/keyhint.js', 'suggest.js', 'account/window.js', 'account/cmd/layer.js', 'account/commands.js'];
  for (const f of files) {
    const src = read('space/web/assets/shell/js/shell/' + f);
    assert.doesNotMatch(src, /function (flatStrings|normCmd|lev)\(/, f);
    assert.doesNotMatch(src, /getElementById\('sgx-i18n-shell'\)/, f + ' 用 shellSection 读字符串表');
  }
});

test('shellSection：读一节；没有元素 / 坏 JSON / 不是对象 → {}', () => {
  const doc = (txt) => ({ getElementById: (id) => (id === 'sgx-i18n-shell' && txt != null ? { textContent: txt } : null) });
  assert.deepEqual(S.shellSection(doc('{"kh":{"ai":"x"}}'), 'kh'), { ai: 'x' });
  assert.deepEqual(S.shellSection(doc(null), 'kh'), {});
  assert.deepEqual(S.shellSection(doc('{oops'), 'kh'), {});
  assert.deepEqual(S.shellSection(doc('{"kh":"str"}'), 'kh'), {});
  assert.deepEqual(S.shellSection(null, 'kh'), {});
  assert.deepEqual(S.flatStrings({ a: { b: 'x', c: 1 }, d: 'y' }), { 'a.b': 'x', d: 'y' });
  assert.equal(P.normCmd('  Sudo   ROOT '), 'sudo root');
});

test('gen-shell：terminal.js / ai-panel.js 过检；term/** 之外的 import（含 import()）、非字面量 import()、term/** 里再往外 import 都拒', () => {
  checkTermImports(path.join(REPO, 'space/web/assets/shell/js/shell/terminal.js'), 'terminal.js');
  checkTermImports(path.join(REPO, 'space/web/assets/shell/js/shell/ai-panel.js'), 'ai-panel.js');
  const root = mkdtempSync(path.join(tmpdir(), 'sgx-t1-'));
  const term = path.join(root, 'term');
  mkdirSync(path.join(term, 'core'), { recursive: true });
  try {
    const w = (f, s) => { writeFileSync(path.join(root, f), s); return path.join(root, f); };
    w('term/core/ok.js', 'export const ok = 1;\n');
    checkTermImports(w('good.js', "import { ok } from './term/core/ok.js';\nexport function g() { return ok; }\n"), 'good.js', term);
    assert.throws(() => checkTermImports(w('a.js', "import { esc } from '../lib/util.js';\nexport function x() {}\n"), 'a.js', term), /只能 import shell\/term/);
    checkTermImports(w('b.js', "export function x() { return import('./term/core/ok.js'); }\n"), 'b.js', term);
    assert.throws(() => checkTermImports(w('b2.js', "export function x() { return import('../lib/x.js'); }\n"), 'b2.js', term), /只能 import shell\/term/);
    assert.throws(() => checkTermImports(w('b3.js', "export function x(p) { return import(p); }\n"), 'b3.js', term), /非字面量/);
    w('term/core/bad.js', "import { t } from '../../lib/toast.js';\nexport const c = 1;\n");
    assert.throws(() => checkTermImports(w('d.js', "import { c } from './term/core/bad.js';\nexport function y() { return c; }\n"), 'd.js', term), /只能 import shell\/term/);
    assert.throws(() => checkTermImports(w('e.js', "import { c } from './term/core/nope.js';\nexport function y() {}\n"), 'e.js', term), /不存在/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
