/**
 * 账号 → 服务状态页的「根凭证使用记录」折叠区：
 * - 渲染（lib/status-view.js renderAudit，纯函数）：合计行、每条结果 / 北京时间 / IP 前缀、空状态、满 50 条提示、转义、坏数据跳过；
 * - 源码守卫：模板里是默认收起的 <details>（不带 open）、没有内联脚本、中英文案齐全；
 *   apps/account-status.js 只在折叠区展开（toggle 且 open）时请求 GET /api/root-audit，页面加载和 60 秒刷新都不碰它；
 *   页面没有角色判断（admin 由网关和接口服务端保证）。
 * 运行：node --test tests/web/ui/root-audit-panel.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { renderAudit, AUDIT_MAX } from '../../../web/assets/js/lib/status-view.js';
import { AUDIT_SHOW } from '../../../workers/auth-gateway/functions/api/root-audit.js';

const read = (p) => readFileSync(new URL('../../../' + p, import.meta.url), 'utf8');
const I18N = read('web/layouts/partials/status-i18n.html');
const DICT = {};
for (const m of I18N.matchAll(/"(\w+)" \(dict "zh" "([^"]*)" "en" "([^"]*)"\)/g)) DICT[m[1]] = { zh: m[2], en: m[3] };

/* 2026-10-09 12:00 北京时间 */
const NOW = Date.UTC(2026, 9, 9, 4, 0, 0);

function mk(en) {
  const t = (k) => {
    assert.ok(DICT[k], 'status-i18n.html 缺文案：' + k);
    return en ? DICT[k].en : DICT[k].zh;
  };
  const fmt = (k, v) => {
    let s = t(k);
    for (const x in v || {}) s = s.split('{' + x + '}').join(String(v[x]));
    return s;
  };
  return { t, fmt, en, now: NOW };
}

test('renderAudit：合计行 + 每条（结果、北京时间、IP 前缀）；今天只给时分，别的日子带日期', () => {
  const items = [
    { ts: NOW - 30 * 60000, ipPrefix: '203.0.113.x', ok: true },
    { ts: NOW - 26 * 3600000, ipPrefix: '2001:db8:1:2::x', ok: false },
  ];
  const zh = renderAudit(items, mk(false));
  assert.match(zh, /<p class="st-audit-meta">共 2 条，失败 1 条（北京时间）<\/p>/);
  assert.equal((zh.match(/<li class="st-audit-item"/g) || []).length, 2);
  assert.match(zh, /data-ok="1"><span class="st-chip" data-state="up">.*成功<\/span><span class="st-audit-time">11:30<\/span><span class="st-audit-ip">203\.0\.113\.x<\/span>/);
  assert.match(zh, /data-ok="0"><span class="st-chip" data-state="down">.*失败<\/span><span class="st-audit-time">10月8日 10:00<\/span><span class="st-audit-ip">2001:db8:1:2::x<\/span>/);
  const en = renderAudit(items, mk(true));
  assert.match(en, /2 records, 1 failed \(Beijing time\)/);
  assert.match(en, />Succeeded</);
  assert.match(en, />Failed</);
  assert.match(en, /Oct 8, 10:00/);
});

test('renderAudit：没有记录 / 不是数组 → 一行「最近 7 天没有使用记录」', () => {
  for (const v of [[], null, undefined, { items: [] }]) {
    assert.equal(renderAudit(v, mk(false)), '<p class="st-audit-none">最近 7 天没有使用记录</p>');
  }
  assert.equal(renderAudit([], mk(true)), '<p class="st-audit-none">No activity in the last 7 days</p>');
});

test('renderAudit：满 50 条（接口上限）时注明只显示最近 50 条；上限与接口一致', () => {
  assert.equal(AUDIT_MAX, AUDIT_SHOW);
  const items = Array.from({ length: AUDIT_MAX }, (_, i) => ({ ts: NOW - i * 60000, ipPrefix: 'p', ok: true }));
  assert.match(renderAudit(items, mk(false)), /共 50 条，失败 0 条（北京时间），只显示最近 50 条/);
  assert.doesNotMatch(renderAudit(items.slice(1), mk(false)), /只显示最近/);
});

test('renderAudit：IP 前缀转义；没有前缀显示「未知 IP」；没有时间戳的坏记录跳过；只有 ok === true 算成功', () => {
  const html = renderAudit([
    { ts: NOW, ipPrefix: '<img src=x onerror=alert(1)>', ok: 'true' },
    { ts: NOW - 1000, ok: true },
    { ipPrefix: 'no-ts', ok: true },
    null,
  ], mk(false));
  assert.ok(!html.includes('<img'), '要转义');
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.match(html, />未知 IP</);
  assert.ok(!html.includes('no-ts'));
  assert.match(html, /共 2 条，失败 1 条/);
});

test('模板：默认收起的 <details id="st-audit">，标题 / 摘要中英都有，没有内联脚本，没有角色判断', () => {
  const tpl = read('web/layouts/_default/account-status.html');
  const m = tpl.match(/<details id="st-audit"[^>]*>/);
  assert.ok(m, '有 <details id="st-audit">');
  assert.ok(!/\bopen\b/.test(m[0]), '默认收起');
  assert.match(tpl, /<div id="st-audit-body" class="st-audit-body" aria-live="polite"/);
  assert.match(tpl, /RootKey activity\{\{ else \}\}根凭证使用记录/);
  assert.match(tpl, /Last 7 days: time, IP prefix and result\{\{ else \}\}最近 7 天：时间、IP 前缀和结果/);
  assert.ok(!/<script(?![^>]*type="application\/json")/.test(tpl), '模板里没有可执行的内联脚本（CSP）');
  assert.ok(!/sgx-role|data-sgx-role|visitor|admin/i.test(tpl.replace(/\{\{\/\*[\s\S]*?\*\/\}\}/g, '')), '页面不做角色判断');
});

test('apps/account-status.js：只在折叠区展开时请求 /api/root-audit；加载和 60 秒刷新不碰它；成功后不重复取', () => {
  const js = read('web/assets/js/apps/account-status.js');
  assert.match(js, /export const AUDIT_API = '\/api\/root-audit';/);
  assert.equal((js.match(/fetch\(AUDIT_API/g) || []).length, 1, '只有一处请求');
  const code = js.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.equal((code.match(/\/api\/root-audit/g) || []).length, 1, '代码里地址只出现在 AUDIT_API 常量');
  /* 调用 loadAudit() 的地方只有两处：toggle（且 open）和「重试」按钮 */
  const calls = [...js.matchAll(/(?<!function )\bloadAudit\(\)/g)].map((m) => js.slice(Math.max(0, m.index - 160), m.index));
  assert.equal(calls.length, 2, 'loadAudit() 调用处：toggle + 重试');
  assert.ok(calls.some((c) => /'toggle'[\s\S]*auditEl\.open\)\s*$/.test(c)), '展开时才取');
  assert.ok(calls.some((c) => /data-audit-retry[\s\S]*auditState = 'idle';\s*$/.test(c)), '重试');
  const visible = js.slice(js.indexOf('visibleInterval(() =>'));
  assert.ok(!/loadAudit|AUDIT_API/.test(visible), '60 秒刷新不取审计');
  assert.match(js, /auditState === 'loading' \|\| auditState === 'done'\) return;/, '取到以后不重复取');
  assert.match(js, /credentials: 'same-origin', cache: 'no-store'/);
  assert.ok(!/sgx-role|data-sgx-role/.test(js), '页面不做角色判断');
});

test('文案：折叠区用到的键中英都有', () => {
  for (const k of ['auditLoading', 'auditNone', 'auditCount', 'auditCap', 'auditOk', 'auditFail', 'auditIpUnknown', 'auditErr', 'auditErrAuth', 'retry']) {
    assert.ok(DICT[k] && DICT[k].zh && DICT[k].en, k);
  }
});
