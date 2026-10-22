/**
 * 聊天页（/chat/）纯函数（web/assets/js/lib/chat-view.js）：安全 Markdown（XSS：<script>、onerror、javascript: 链接）、
 * 段落 / 粗体 / 行内代码 / 代码块 / 列表 / 链接、来源 chip、SSE 解析（跨块）、发给 /api/chat 的对话裁剪、错误文案；
 * 以及 apps/chat.js 用到的文案都在 partials/chat-i18n.html 里（中英都有）。
 * 运行：node --test tests/web/ui/chat-view.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  buildPayload, createSseParser, errorInfo, renderInline, renderMarkdown, renderSources, safeUrl, sourceLabel, MAX_MESSAGES, MAX_TOTAL,
} from '../../../web/assets/js/lib/chat-view.js';

/** 渲染结果里不允许出现的东西：任何真标签都只能是白名单里的 */
const ALLOWED_TAGS = new Set(['p', 'br', 'strong', 'em', 'code', 'pre', 'ul', 'ol', 'li', 'a', 'blockquote', 'hr']);
function assertSafe(html) {
  for (const m of html.matchAll(/<\/?([a-zA-Z][a-zA-Z0-9-]*)([^>]*)>/g)) {
    assert.ok(ALLOWED_TAGS.has(m[1].toLowerCase()), '不该出现的标签：' + m[0]);
    const attrs = m[2];
    if (m[0].startsWith('</')) { assert.equal(attrs, '', m[0]); continue; }
    assert.ok(!/\son[a-z]+\s*=/i.test(attrs), '不该有事件属性：' + m[0]);
    if (m[1] === 'a') {
      assert.match(attrs, /^ href="https?:\/\/[^"]*" target="_blank" rel="noopener noreferrer"$/, m[0]);
    } else if (m[1] === 'p') {
      assert.ok(attrs === '' || attrs === ' class="chat-h"', m[0]);
    } else if (m[1] === 'ol') {
      assert.ok(attrs === '' || /^ start="\d+"$/.test(attrs), m[0]);
    } else {
      assert.equal(attrs.trim(), '', m[0]);
    }
  }
}

test('XSS：<script>、<img onerror>、<svg onload>、属性注入都只当文字', () => {
  const cases = [
    '<script>alert(1)</script>',
    '<img src=x onerror=alert(1)>',
    '"><svg onload=alert(1)>',
    '**<b onmouseover="x">粗</b>**',
    '`<script>`',
    '```\n<script>alert(1)</script>\n```',
    '- <iframe src="javascript:alert(1)"></iframe>',
    '> <a href="javascript:1">q</a>',
    '# <h1>title</h1>',
  ];
  for (const c of cases) {
    const html = renderMarkdown(c);
    assertSafe(html);
    assert.ok(!/<(script|img|svg|iframe|b|h1)\b/i.test(html), html);
  }
  assert.equal(renderMarkdown('<script>alert(1)</script>'), '<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>');
  assert.equal(renderMarkdown('<img src=x onerror=alert(1)>'), '<p>&lt;img src=x onerror=alert(1)&gt;</p>');
});

test('XSS：javascript: / data: / vbscript: / 相对地址 链接只留文字；地址里的引号不能跳出 href', () => {
  for (const u of ['javascript:alert(1)', 'JavaScript:alert(1)', ' javascript:alert(1)', 'data:text/html,<script>1</script>', 'vbscript:x', '/relative', '//evil.com/x', 'java\tscript:x']) {
    const html = renderMarkdown('[点我](' + u + ')');
    assertSafe(html);
    assert.ok(!html.includes('<a'), u + ' → ' + html);
    assert.ok(html.includes('点我'));
  }
  const html = renderMarkdown('[x](https://a.com/"onmouseover="alert(1))');
  assertSafe(html);
  assert.ok(!/"\s*onmouseover="/.test(html), html);
  const bare = renderMarkdown('看 https://a.com/?q="><script>alert(1)</script>');
  assertSafe(bare);
  assert.ok(!bare.includes('<script'), bare);
  assert.equal(safeUrl('https://ok.com/a b'), '');
  assert.equal(safeUrl('https://ok.com/\u0000'), '');
  assert.equal(safeUrl('HTTPS://ok.com/a'), 'HTTPS://ok.com/a');
});

test('Markdown：段落、换行、粗体、斜体、行内代码、标题、引用、分隔线', () => {
  assert.equal(renderMarkdown('第一段\n同一段\n\n第二段'), '<p>第一段<br>同一段</p><p>第二段</p>');
  assert.equal(renderInline('**粗** 和 *斜* 和 `a<b>`'), '<strong>粗</strong> 和 <em>斜</em> 和 <code>a&lt;b&gt;</code>');
  assert.equal(renderInline('`**不加粗**`'), '<code>**不加粗**</code>');
  assert.equal(renderInline('snake_case_name 和 2*3*4'), 'snake_case_name 和 2*3*4');
  assert.equal(renderInline('**`code` 加粗**'), '<strong><code>code</code> 加粗</strong>');
  assert.equal(renderMarkdown('## 标题'), '<p class="chat-h">标题</p>');
  assert.equal(renderMarkdown('> 引用\n> 第二行'), '<blockquote>引用<br>第二行</blockquote>');
  assert.equal(renderMarkdown('a\n\n---\n\nb'), '<p>a</p><hr><p>b</p>');
  assert.equal(renderMarkdown(''), '');
  assert.equal(renderMarkdown('   \n\n  '), '');
});

test('Markdown：代码块（含语言、没闭合时延到末尾——流式中）', () => {
  assert.equal(renderMarkdown('```js\nconst a = 1 < 2;\n```\n后面'), '<pre><code>const a = 1 &lt; 2;</code></pre><p>后面</p>');
  assert.equal(renderMarkdown('前面\n```\nline1\nline2'), '<p>前面</p><pre><code>line1\nline2</code></pre>');
  assert.equal(renderMarkdown('```\n**不渲染** [x](https://a.com)\n```'), '<pre><code>**不渲染** [x](https://a.com)</code></pre>');
});

test('Markdown：无序 / 有序列表、续行、列表后接段落', () => {
  assert.equal(renderMarkdown('- 一\n- **二**\n* 三'), '<ul><li>一</li><li><strong>二</strong></li><li>三</li></ul>');
  assert.equal(renderMarkdown('1. a\n2. b'), '<ol><li>a</li><li>b</li></ol>');
  assert.equal(renderMarkdown('3) c\n4) d'), '<ol start="3"><li>c</li><li>d</li></ol>');
  assert.equal(renderMarkdown('- a\n  续行\n\n段落'), '<ul><li>a<br>续行</li></ul><p>段落</p>');
  assert.equal(renderMarkdown('- a\n  - 子项'), '<ul><li>a</li><li>子项</li></ul>');
  assert.equal(renderMarkdown('介绍：\n- a'), '<p>介绍：</p><ul><li>a</li></ul>');
});

test('链接：[文字](https) 和裸地址；新标签页、noopener；结尾标点不算进地址', () => {
  assert.equal(renderInline('[Hugo](https://gohugo.io/)'), '<a href="https://gohugo.io/" target="_blank" rel="noopener noreferrer">Hugo</a>');
  assert.equal(renderInline('[**粗**链接](https://a.com "标题")'), '<a href="https://a.com" target="_blank" rel="noopener noreferrer"><strong>粗</strong>链接</a>');
  assert.equal(renderInline('见 https://a.com/x?a=1&b=2。'), '见 <a href="https://a.com/x?a=1&amp;b=2" target="_blank" rel="noopener noreferrer">https://a.com/x?a=1&amp;b=2</a>。');
  assert.equal(renderInline('(https://a.com/p).'), '(<a href="https://a.com/p" target="_blank" rel="noopener noreferrer">https://a.com/p</a>).');
  assert.equal(renderInline('https://a.com，然后'), '<a href="https://a.com" target="_blank" rel="noopener noreferrer">https://a.com</a>，然后');
  assert.equal(renderInline('**https://a.com**'), '<strong><a href="https://a.com" target="_blank" rel="noopener noreferrer">https://a.com</a></strong>');
  /* 占位符字符在输入里不能被利用 */
  assert.equal(renderInline('\u00010\u0001x'), '0x');
  assertSafe(renderMarkdown('[a](https://a.com) https://b.com `c` **d**'));
});

test('来源 chip：Gemini 跳转地址用 title 当域名；普通地址取主机名 + 标题；只放 http(s)、最多 8 个、转义', () => {
  assert.deepEqual(sourceLabel({ title: 'gohugo.io', uri: 'https://vertexaisearch.cloud.google.com/grounding-api-redirect/x' }), { host: 'gohugo.io', title: '' });
  assert.deepEqual(sourceLabel({ title: 'Hugo Releases', uri: 'https://www.github.com/gohugoio/hugo/releases' }), { host: 'github.com', title: 'Hugo Releases' });
  assert.deepEqual(sourceLabel({ title: '某篇文章', uri: 'https://vertexaisearch.cloud.google.com/x' }), { host: '某篇文章', title: '' });
  assert.deepEqual(sourceLabel({ title: '', uri: 'https://example.com/a' }), { host: 'example.com', title: '' });
  const html = renderSources([
    { title: 'a.com', uri: 'https://vertexaisearch.cloud.google.com/1' },
    { title: '<img src=x onerror=1>', uri: 'https://b.com/"x' },
    { title: 'bad', uri: 'javascript:alert(1)' },
  ], '来源');
  assert.ok(html.startsWith('<ul class="chat-srcs" aria-label="来源">'), html);
  assert.equal((html.match(/<a /g) || []).length, 2);
  assert.ok(!html.includes('javascript:'));
  assert.ok(!html.includes('<img'));
  assert.ok(html.includes('href="https://b.com/&quot;x"'));
  assert.ok(html.includes('rel="noopener noreferrer"'));
  assert.equal(renderSources([], 'x'), '');
  assert.equal(renderSources(null, 'x'), '');
  const many = Array.from({ length: 12 }, (_, i) => ({ title: 's' + i + '.com', uri: 'https://s' + i + '.com/' }));
  assert.equal((renderSources(many, 'x').match(/<li>/g) || []).length, 8);
});

test('SSE 解析：跨块拼接、\\r\\n、多事件、坏 JSON 跳过、end() 收尾', () => {
  const got = [];
  const p = createSseParser((e) => got.push(e));
  p.push('data: {"t":"del');
  p.push('ta","text":"a"}\n');
  p.push('\ndata: {"t":"delta","text":"b"}\r\n\r\ndata: {bad}\n\n: comment\n\n');
  p.push('data: {"t":"done"}');
  assert.deepEqual(got, [{ t: 'delta', text: 'a' }, { t: 'delta', text: 'b' }]);
  p.end();
  assert.deepEqual(got[2], { t: 'done' });
  assert.equal(got.length, 3);
});

test('buildPayload：合并相邻同角色、去空、最后必须是 user、≤ 20 条 / ≤ 24000 字从新往旧取、开头是 user', () => {
  assert.deepEqual(buildPayload([{ role: 'user', text: ' a ' }]), [{ role: 'user', text: 'a' }]);
  assert.equal(buildPayload([]), null);
  assert.equal(buildPayload([{ role: 'user', text: 'a' }, { role: 'model', text: 'b' }]), null);
  assert.deepEqual(buildPayload([{ role: 'user', text: 'a' }, { role: 'user', text: 'b' }, { role: 'model', text: '' }]), [{ role: 'user', text: 'a\n\nb' }]);
  assert.deepEqual(buildPayload([{ role: 'model', text: 'hi' }, { role: 'user', text: 'q' }]), [{ role: 'user', text: 'q' }]);
  const long = Array.from({ length: 30 }, (_, i) => ({ role: i % 2 ? 'model' : 'user', text: 'm' + i }));
  long.push({ role: 'user', text: 'last' });
  /* 30 条交替 + 最后一条 user：29 和 30 合并 → 30 条；取最近 20 条后开头不能是 model */
  const p = buildPayload(long);
  assert.ok(p.length <= MAX_MESSAGES);
  assert.equal(p[0].role, 'user');
  assert.equal(p[p.length - 1].role, 'user');
  assert.ok(p[p.length - 1].text.endsWith('last'));
  const big = Array.from({ length: 9 }, (_, i) => ({ role: i % 2 ? 'model' : 'user', text: 'x'.repeat(5000) }));
  const pb = buildPayload(big);
  const total = pb.reduce((n, m) => n + m.text.length, 0);
  assert.ok(total <= MAX_TOTAL, String(total));
  assert.ok(pb.every((m) => m.text.length <= 4000));
  assert.equal(pb[0].role, 'user');
});

test('errorInfo：额度 / 没配置 / 太长 不给重试，其他给', () => {
  assert.deepEqual(errorInfo('rate_limited'), { key: 'errRate', retry: false });
  assert.deepEqual(errorInfo('no_key'), { key: 'errNoKey', retry: false });
  assert.deepEqual(errorInfo('bad_request'), { key: 'errTooLong', retry: false });
  assert.deepEqual(errorInfo('upstream'), { key: 'errUpstream', retry: true });
  assert.deepEqual(errorInfo('whatever'), { key: 'errUpstream', retry: true });
});

test('文案：apps/chat.js 用到的 key 在 chat-i18n.html 里都有中英', () => {
  const src = readFileSync(new URL('../../../web/layouts/partials/chat-i18n.html', import.meta.url), 'utf8');
  const dict = {};
  for (const m of src.matchAll(/"([A-Za-z0-9]+)" \(dict "zh" "([^"]*)" "en" "([^"]*)"\)/g)) dict[m[1]] = { zh: m[2], en: m[3] };
  const app = readFileSync(new URL('../../../web/assets/js/apps/chat.js', import.meta.url), 'utf8');
  const used = new Set([...app.matchAll(/\bt\('([A-Za-z0-9]+)'\)/g)].map((m) => m[1]));
  for (const k of ['errRate', 'errNoKey', 'errTooLong', 'errUpstream']) used.add(k);
  for (const k of ['errAuth', 'errAuthSub', 'ownerOnly', 'ownerOnlySub', 'stop', 'send']) used.add(k);
  for (const k of used) {
    assert.ok(dict[k], 'chat-i18n.html 缺文案：' + k);
    assert.ok(dict[k].zh && dict[k].en, k);
  }
  assert.equal(dict.errRate.zh, '今天的免费额度用完了，明天再来');
  assert.equal(dict.errNoKey.zh, '聊天还没配置');
  assert.equal(dict.ownerOnly.zh, '聊天仅主人可用');
  assert.equal(dict.ownerOnly.en, 'Chat is owner-only');
});
