/**
 * AI 窗口回答渲染（2026-11 AI 语义召回）：shell/ai-panel.js 的有限 Markdown（mdParse / renderMd / linkInfo / shortLabel / sourcesBlock）。
 * - 只认段落、换行、列表、**粗体**、[文字](地址)、裸网址；其余当文字（HTML 原样当文字，不进 DOM）
 * - 链接只认 http(s) 和站内绝对路径；站内同页（交给 onInternal 关窗口后跳转）、站外新标签 + rel=noopener；文字后带 ↗
 * - 长网址不当链接文字：同一条回答里的 [标题](同一地址) 优先，否则「域名/…」
 * - gemini 联网来源追加成「来源」列表
 * DOM 用极简替身（只实现 renderMd 用到的 createElement / createTextNode / createDocumentFragment），不需要浏览器。
 * 运行：node --test tests/space/ui/shell/ai-markdown.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

globalThis.window = globalThis.window || {};
const AP = await import('../../../../space/web/assets/shell/js/ai/ai-panel.js');
const HERE = { host: 'styrigx.com', origin: 'https://styrigx.com' };

/** 极简 DOM 替身 */
function fakeDoc() {
  class Node {
    constructor(tag) { this.tag = tag; this.children = []; this.attrs = {}; this.listeners = {}; this.className = ''; this._text = ''; }
    appendChild(c) { this.children.push(c); return c; }
    setAttribute(k, v) { this.attrs[k] = String(v); }
    addEventListener(t, f) { (this.listeners[t] = this.listeners[t] || []).push(f); }
    set textContent(v) { this.children = []; this._text = String(v); }
    get textContent() { return this._text + this.children.map((c) => c.textContent).join(''); }
    set innerHTML(v) { throw new Error('innerHTML used'); }
  }
  class Text { constructor(v) { this.tag = '#text'; this.v = v; } get textContent() { return this.v; } }
  return {
    createElement: (t) => new Node(t),
    createTextNode: (v) => new Text(v),
    createDocumentFragment: () => new Node('#frag'),
  };
}
/** 替身树 → 简写，便于断言 */
function tree(n) {
  if (n.tag === '#text') return n.v;
  const kids = (n._text ? [n._text] : []).concat(n.children.map(tree));
  const o = { [n.tag]: kids };
  if (n.tag === 'a') Object.assign(o, { href: n.href, target: n.target, rel: n.rel, cls: n.className });
  return o;
}

test('mdParse：段落 / 换行 / 列表 / 粗体 / 链接 / 裸网址；标题 # 去掉；HTML 当文字', () => {
  const b = AP.mdParse('第一行\n第二行 **重点**\n\n- 甲 [主题](https://styrigx.com/theme/)\n- 乙\n1. 一\n2) 二\n# 标题\n<img src=x onerror=alert(1)>');
  assert.deepEqual(b.map((x) => x.t), ['p', 'ul', 'ol', 'p']);
  assert.deepEqual(b[0].c, [{ t: 'text', v: '第一行' }, { t: 'br' }, { t: 'text', v: '第二行 ' }, { t: 'b', v: '重点' }]);
  assert.deepEqual(b[1].items[0], [{ t: 'text', v: '甲 ' }, { t: 'a', text: '主题', href: 'https://styrigx.com/theme/' }]);
  assert.equal(b[2].items.length, 2);
  assert.deepEqual(b[3].c, [{ t: 'text', v: '标题' }, { t: 'br' }, { t: 'text', v: '<img src=x onerror=alert(1)>' }]);
  /* 裸网址：句末标点不进链接；同一条回答里有 [标题](同一地址) 就用标题 */
  const c = AP.mdParse('看 https://styrigx.com/blog/zh/post/very-long-slug-here/。\n- [锁屏的设计](https://styrigx.com/blog/zh/post/very-long-slug-here/)');
  assert.deepEqual(c[0].c[1], { t: 'a', text: '锁屏的设计', href: 'https://styrigx.com/blog/zh/post/very-long-slug-here/' });
  assert.deepEqual(c[0].c[2], { t: 'text', v: '。' });
  /* 文字就是网址的链接 → 短名 */
  assert.deepEqual(AP.mdParse('[https://example.org/a/b/c](https://example.org/a/b/c)')[0].c[0], { t: 'a', text: 'example.org/…', href: 'https://example.org/a/b/c' });
  assert.equal(AP.shortLabel('https://www.example.org/'), 'example.org');
});

test('linkInfo：只认 http(s) 和站内绝对路径；同 host 算站内', () => {
  assert.deepEqual(AP.linkInfo('/curio/movies/', HERE), { href: '/curio/movies/', internal: true });
  assert.deepEqual(AP.linkInfo('https://styrigx.com/theme/', HERE), { href: 'https://styrigx.com/theme/', internal: true });
  assert.deepEqual(AP.linkInfo('https://example.org/x', HERE), { href: 'https://example.org/x', internal: false });
  for (const bad of ['javascript:alert(1)', 'data:text/html,x', '//evil.com/x', 'vbscript:x', 'mailto:a@b.c', 'relative/path', '']) assert.equal(AP.linkInfo(bad, HERE), null, bad);
});

test('renderMd：只用 createElement / textContent（不碰 innerHTML）；站外新标签 + rel=noopener + 读屏提示；站内交给 onInternal；坏协议当文字', () => {
  const doc = fakeDoc();
  const went = [];
  const frag = AP.renderMd(doc, '**粗** <b>x</b>\n- [主题](https://styrigx.com/theme/) 和 [外站](https://example.org/)\n- [坏](javascript:void0) [坏2](javascript:alert(1))', { here: HERE, newTab: '（在新标签页打开）', onInternal: (u) => went.push(u) });
  const t = tree(frag);
  assert.deepEqual(t['#frag'][0], { p: [{ strong: ['粗'] }, ' <b>x</b>'] });
  const ul = t['#frag'][1].ul;
  const [inA, , outA] = ul[0].li;
  assert.deepEqual(inA, { a: [{ span: ['主题'] }, { span: ['↗'] }], href: 'https://styrigx.com/theme/', target: undefined, rel: undefined, cls: 'sgx-ai-link' });
  assert.equal(outA.target, '_blank');
  assert.equal(outA.rel, 'noopener');
  assert.deepEqual(ul[1].li, ['坏', ' [坏2](javascript:alert(1))'], 'javascript: 当文字（不成链接）');
  /* 站内链接点击：preventDefault + onInternal；带修饰键不拦 */
  const a = frag.children[1].children[0].children[0];
  assert.equal(a.children[1].attrs['aria-hidden'], 'true');
  let prevented = false;
  a.listeners.click[0]({ defaultPrevented: false, button: 0, preventDefault() { prevented = true; } });
  assert.equal(prevented, true);
  assert.deepEqual(went, ['https://styrigx.com/theme/']);
  a.listeners.click[0]({ defaultPrevented: false, button: 0, ctrlKey: true, preventDefault() { throw new Error('should not'); } });
  const ext = frag.children[1].children[0].children[2];
  assert.equal(ext.attrs['aria-label'], '外站 （在新标签页打开）');
});

test('sourcesBlock：来源列表（只认 http(s)、最多 8 条、标题里的方括号换掉、括号 / 空白转义）；空 → 空串', () => {
  const s = AP.sourcesBlock([{ title: 'A [x]', url: 'https://a.com/p(1)' }, { title: '', url: 'https://www.b.org/' }, { title: 'bad', url: 'javascript:1' }], '来源');
  assert.equal(s, '\n\n来源\n- [A (x)](https://a.com/p%281%29)\n- [b.org](https://www.b.org/)');
  const parsed = AP.mdParse('答' + s);
  assert.deepEqual(parsed[2].items.map((i) => i[0]), [{ t: 'a', text: 'A (x)', href: 'https://a.com/p%281%29' }, { t: 'a', text: 'b.org', href: 'https://www.b.org/' }]);
  assert.equal(AP.sourcesBlock([], '来源'), '');
  assert.equal(AP.sourcesBlock(null, '来源'), '');
  assert.equal(AP.sourcesBlock(Array.from({ length: 12 }, (_, i) => ({ title: 't' + i, url: 'https://x.com/' + i })), 'S').split('\n- ').length - 1, 8);
});

test('ai-panel.js：不用 innerHTML / insertAdjacentHTML；助手回答走 renderMd；处理 event: sources；文案表有 sources / newTab（中英）', () => {
  const src = readFileSync(new URL('../../../../space/web/assets/shell/js/ai/ai-panel.js', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /\.innerHTML\s*=|insertAdjacentHTML|outerHTML\s*=/);
  assert.match(src, /renderMd\(doc, text,/);
  assert.match(src, /ev === 'sources'/);
  for (const lang of ['en', 'zh']) {
    const y = readFileSync(new URL('../../../../space/web/data/sgx-shell-i18n/' + lang + '.yaml', import.meta.url), 'utf8');
    assert.match(y, /^ {2}sources: \S/m, lang);
    assert.match(y, /^ {2}newTab: \S/m, lang);
  }
  const css = readFileSync(new URL('../../../../space/web/assets/shell/css/input.css', import.meta.url), 'utf8');
  assert.match(css, /\.sgx-ai-link-text \{[^}]*underline dotted/);
});
