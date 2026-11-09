/**
 * styrigx-ai 外部模型换 Gemini 3（2026-11-09，fix/ai-gemini-3）：
 * Workers Logs 2026-11-09 06:12 UTC 上游 404「gemini-2.5-flash no longer available to new users」，之前直接换 3.8 Flash 也不行。
 * 第二轮（fix/ai-gemini-lite）：免费档 Flash-Lite 作主力、3.8 Flash 429 换 Lite 一次、Lite 也 429 → daily_limit、Lite 思考 minimal。
 * 这里覆盖：3.x 低思考 + 更大的输出额度；首字前 429 / 503 退避重试、首字超时、总时限；搜索被拒（任何 4xx，除地区 / 钥匙 / 404 / 429）
 * 不带工具重试一次并记住；空回答记 [ai] gemini empty（finishReason + usage）回 error empty；退役 id 换成当前 id；AQ. 钥匙脱敏。
 * 不调真实 Gemini：替换 globalThis.fetch。
 * 运行：node --test tests/workers/ai/gemini3.test.mjs
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

const W = '../../../workers/ai/src/';
const app = (await import(W + 'app.js')).default;
const R = await import(W + 'core/recall.js');
const M = await import(W + 'core/models.js');
const G = await import(W + 'core/gemini.js');

const SPACE = { items: [{ id: 's1', type: 'setting', lang: 'zh', title: '主题模式', text: '深色和浅色主题切换。', url: '/theme/' }] };
const kvOf = (map) => ({ async get(k, t) { const v = map[k]; return v == null ? null : t === 'json' ? JSON.parse(v) : v; } });
const sse = (o) => 'data: ' + JSON.stringify(o) + '\n\n';
const MODEL = 'gemini-3.8-flash';
const gEnv = (o = {}, reg) => ({
  KV_SEARCH_INDEX: kvOf({ 'site:space': JSON.stringify(SPACE), 'ai:models': JSON.stringify(reg || { default: MODEL, models: [{ id: MODEL, label: 'Gemini 3.8 Flash', provider: 'gemini' }] }) }),
  SGX_CHAT_API_KEY: 'AQ.Ab8RN6SECRETSECRETSECRET',
  ...o,
});
function ask(body, env, init = {}) {
  return app.fetch(new Request('https://styrigx-ai/ask', { method: 'POST', headers: { 'Content-Type': 'application/json', ...(init.headers || {}) }, body: JSON.stringify(body), signal: init.signal }), env);
}
async function events(res) {
  const txt = await res.text();
  return txt.split('\n\n').filter(Boolean).map((b) => ({ event: /^event: (.+)$/m.exec(b)[1], data: JSON.parse(/^data: (.+)$/m.exec(b)[1]) }));
}
async function withFetch(fn, run) {
  const orig = globalThis.fetch;
  globalThis.fetch = fn;
  try { return await run(); } finally { globalThis.fetch = orig; }
}
async function withConsole(run) {
  const lines = [];
  const orig = console.error;
  console.error = (...a) => { lines.push(a.map(String).join(' ')); };
  try { await run(); } finally { console.error = orig; }
  return lines;
}
const ok = (text) => new Response(sse({ candidates: [{ content: { parts: [{ text }] } }] }), { status: 200 });
const err = (status, message, gs) => new Response(JSON.stringify({ error: { code: status, message, status: gs } }), { status });
/** 首字一直不来的流（只在 signal abort 时报错，像真 fetch 一样） */
function hangingBody(signal) {
  return new ReadableStream({
    start(c) { signal.addEventListener('abort', () => c.error(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true }); },
  });
}

const DEFAULT_TIMING = { ...G.GEMINI_TIMING, backoffMs: [...G.GEMINI_TIMING.backoffMs] };
beforeEach(() => {
  R._resetCache(); M._resetModelsCache(); G._resetGeminiState();
  Object.assign(G.GEMINI_TIMING, { firstByteMs: 2000, backoffMs: [5, 10], minAttemptMs: 1 });
});

test('默认节奏：首字 20 秒、退避 0.8 / 2 秒（最多 2 次）、总时限 60 秒', () => {
  assert.deepEqual(DEFAULT_TIMING, { firstByteMs: 20000, backoffMs: [800, 2000], minAttemptMs: 3000 });
  assert.equal(G.UPSTREAM_TIMEOUT_MS, 60000);
  assert.ok(DEFAULT_TIMING.firstByteMs * 3 + 800 + 2000 > G.UPSTREAM_TIMEOUT_MS, '三次都满 20 秒时由总时限截住，不会超过 60 秒');
});

test('3.x：thinkingConfig.thinkingLevel = low（不发 thinkingBudget），maxOutputTokens 至少 4096、封顶 8192；2.x 不带', async () => {
  const bodies = [];
  await withFetch(async (u, init) => { bodies.push({ url: String(u), body: JSON.parse(init.body) }); return ok('好'); }, async () => {
    const ev = await events(await ask({ q: '主题', lang: 'zh' }, gEnv()));
    assert.deepEqual(ev.map((e) => e.event), ['delta', 'done']);
  });
  assert.match(bodies[0].url, /\/models\/gemini-3\.8-flash:streamGenerateContent\?alt=sse$/);
  assert.deepEqual(bodies[0].body.generationConfig, { maxOutputTokens: 4096, thinkingConfig: { thinkingLevel: 'low' } });
  assert.equal(G.geminiMaxTokens(1024), 4096);
  assert.equal(G.geminiMaxTokens(6000), 6000);
  assert.equal(G.geminiMaxTokens(100000), 8192);
  for (const id of ['gemini-3.8-flash', 'gemini-3-flash-preview', 'gemini-3.5-flash-lite', 'gemini-4-argon', 'models/gemini-3.6-flash']) assert.equal(G.isThinkingLevelModel(id), true, id);
  for (const id of ['gemini-2.5-flash', 'gemini-2.5-flash-lite', 'gemini-x', '@cf/google/gemma-4-26b-a4b-it', '']) assert.equal(G.isThinkingLevelModel(id), false, id);
  assert.equal(G.geminiBody([{ role: 'user', content: 'x' }], 4096, { model: 'gemini-2.5-flash-lite' }).generationConfig.thinkingConfig, undefined);
});

test('首字前 503 退避重试，最多 2 次；第三次成功照常回答', async () => {
  let n = 0;
  let ev;
  const lines = await withConsole(() => withFetch(async () => (++n <= 2 ? err(503, 'The model is overloaded. Please try again later.', 'UNAVAILABLE') : ok('在设置里')), async () => {
    ev = await events(await ask({ q: '主题', lang: 'zh' }, gEnv()));
  }));
  assert.equal(n, 3);
  assert.deepEqual(ev.map((e) => e.event), ['delta', 'done']);
  assert.equal(lines.filter((l) => l.includes('[ai] gemini retry')).length, 2);
});

test('503 一直不好：重试 2 次后 error upstream（日志带 attempts=3、reason=server）', async () => {
  let n = 0;
  let ev;
  const lines = await withConsole(() => withFetch(async () => { n++; return err(503, 'overloaded', 'UNAVAILABLE'); }, async () => {
    ev = await events(await ask({ q: '主题' }, gEnv()));
  }));
  assert.equal(n, 3);
  assert.deepEqual(ev, [{ event: 'error', data: { code: 'upstream' } }]);
  const log = lines.find((l) => l.includes('[ai] gemini upstream'));
  assert.match(log, /"attempts":3/);
  assert.match(log, /"reason":"server"/);
});

const QUOTA_DAY = JSON.stringify({ error: { code: 429, status: 'RESOURCE_EXHAUSTED', message: 'You exceeded your current quota. Quota exceeded for metric: generate_content_free_tier_requests, limit: 20', details: [{ violations: [{ quotaId: 'GenerateRequestsPerDayPerProjectPerModel-FreeTier' }] }] } });
const QUOTA_MIN = JSON.stringify({ error: { code: 429, status: 'RESOURCE_EXHAUSTED', message: 'Quota exceeded', details: [{ violations: [{ quotaId: 'GenerateRequestsPerMinutePerProjectPerModel-FreeTier' }] }] } });
const modelOf = (u) => /\/models\/([^:]+):/.exec(String(u))[1];

test('3.8 Flash 429 → 不等，换 3.5 Flash-Lite 一次（[ai] gemini fallback，Lite 用 minimal 思考）→ 正常回答', async () => {
  const seen = [];
  let ev;
  const lines = await withConsole(() => withFetch(async (u, init) => {
    seen.push({ model: modelOf(u), body: JSON.parse(init.body) });
    return modelOf(u) === 'gemini-3.8-flash' ? new Response(QUOTA_DAY, { status: 429 }) : ok('好');
  }, async () => {
    ev = await events(await ask({ q: '主题' }, gEnv()));
  }));
  assert.deepEqual(seen.map((x) => x.model), ['gemini-3.8-flash', 'gemini-3.5-flash-lite']);
  assert.deepEqual(seen[0].body.generationConfig.thinkingConfig, { thinkingLevel: 'low' });
  assert.deepEqual(seen[1].body.generationConfig.thinkingConfig, { thinkingLevel: 'minimal' });
  assert.deepEqual(ev.map((e) => e.event), ['delta', 'done']);
  const log = lines.find((l) => l.includes('[ai] gemini fallback'));
  assert.ok(log, lines.join('\n'));
  assert.match(log, /"from":"gemini-3.8-flash","to":"gemini-3.5-flash-lite"/);
  assert.equal(lines.filter((l) => l.includes('[ai] gemini retry')).length, 0, '429 不退避');
});

test('3.8 Flash 429、Lite 也 429（每天额度）→ error daily_limit；只换一次', async () => {
  const seen = [];
  let ev;
  const lines = await withConsole(() => withFetch(async (u) => { seen.push(modelOf(u)); return new Response(QUOTA_DAY, { status: 429 }); }, async () => {
    ev = await events(await ask({ q: '主题' }, gEnv()));
  }));
  assert.deepEqual(seen, ['gemini-3.8-flash', 'gemini-3.5-flash-lite']);
  assert.deepEqual(ev, [{ event: 'error', data: { code: 'daily_limit' } }]);
  assert.match(lines.find((l) => l.includes('[ai] gemini upstream')), /"model":"gemini-3.5-flash-lite","picked":"gemini-3.8-flash"/);
});

test('直接选 Lite：每天额度 429 → daily_limit 不重试；每分钟限额 429 → 退避重试，仍不行 → rate_limited', async () => {
  const LITE = { default: 'gemini-3.5-flash-lite', models: [{ id: 'gemini-3.5-flash-lite', provider: 'gemini' }] };
  let n = 0;
  let ev;
  await withConsole(() => withFetch(async () => { n++; return new Response(QUOTA_DAY, { status: 429 }); }, async () => {
    ev = await events(await ask({ q: '主题' }, gEnv({}, LITE)));
  }));
  assert.equal(n, 1);
  assert.equal(ev[0].data.code, 'daily_limit');
  M._resetModelsCache(); R._resetCache(); n = 0;
  await withConsole(() => withFetch(async () => { n++; return new Response(QUOTA_MIN, { status: 429 }); }, async () => {
    ev = await events(await ask({ q: '主题' }, gEnv({}, LITE)));
  }));
  assert.equal(n, 3);
  assert.equal(ev[0].data.code, 'rate_limited');
  M._resetModelsCache(); R._resetCache(); n = 0;
  await withConsole(() => withFetch(async () => (++n === 1 ? new Response(QUOTA_MIN, { status: 429 }) : ok('好')), async () => {
    ev = await events(await ask({ q: '主题' }, gEnv({}, LITE)));
  }));
  assert.deepEqual(ev.map((e) => e.event), ['delta', 'done']);
});

test('换模型 / 思考档的规则', () => {
  assert.equal(G.quotaFallbackFor('gemini-3.8-flash'), 'gemini-3.5-flash-lite');
  assert.equal(G.quotaFallbackFor('gemini-3.6-flash'), 'gemini-3.5-flash-lite');
  assert.equal(G.quotaFallbackFor('gemini-3.5-flash-lite'), '');
  assert.equal(G.quotaFallbackFor('gemini-3.1-flash-lite'), '');
  assert.equal(G.quotaFallbackFor('gemini-2.5-flash-lite'), '');
  assert.equal(G.quotaFallbackFor('gemini-x'), '');
  assert.equal(G.thinkingLevelFor('gemini-3.5-flash-lite'), 'minimal');
  assert.equal(G.thinkingLevelFor('gemini-3.1-flash-lite'), 'minimal');
  assert.equal(G.thinkingLevelFor('gemini-3.8-flash'), 'low');
  assert.equal(G.thinkingLevelFor('gemini-4-argon'), 'low');
  assert.equal(G.thinkingLevelFor('gemini-2.5-flash-lite'), '');
  assert.equal(G.perMinuteQuota(QUOTA_MIN), true);
  assert.equal(G.perMinuteQuota(QUOTA_DAY), false);
  assert.equal(G.perMinuteQuota('{}'), false, '说不清的按每天');
});

test('首字超时：每次尝试 firstByteMs 后放弃并重试；都超时 → error timeout，不挂到 60 秒', async () => {
  Object.assign(G.GEMINI_TIMING, { firstByteMs: 40, backoffMs: [5, 5] });
  let n = 0;
  let ev;
  const t0 = Date.now();
  await withConsole(() => withFetch(async (u, init) => { n++; return new Response(hangingBody(init.signal), { status: 200 }); }, async () => {
    ev = await events(await ask({ q: '主题' }, gEnv()));
  }));
  assert.equal(n, 3);
  assert.deepEqual(ev, [{ event: 'error', data: { code: 'timeout' } }]);
  assert.ok(Date.now() - t0 < 2000);
  /* 第一次超时、第二次来字 → 正常回答 */
  M._resetModelsCache(); R._resetCache(); n = 0;
  await withConsole(() => withFetch(async (u, init) => (++n === 1 ? new Response(hangingBody(init.signal), { status: 200 }) : ok('好')), async () => {
    ev = await events(await ask({ q: '主题' }, gEnv()));
  }));
  assert.deepEqual(ev.map((e) => e.event), ['delta', 'done']);
});

test('总时限：剩余时间不够再发一次就停（geminiOpen deadline）', async () => {
  let n = 0;
  Object.assign(G.GEMINI_TIMING, { minAttemptMs: 50 });
  const r = await withConsole(() => withFetch(async () => { n++; return err(503, 'overloaded', 'UNAVAILABLE'); }, async () => {
    const out = await G.geminiOpen({}, 'k', MODEL, [{ role: 'user', content: 'x' }], 4096, { deadline: Date.now() + 60 });
    assert.equal(out.ok, false);
  }));
  assert.ok(n >= 1 && n <= 2, String(n));
});

test('搜索被拒：任何 4xx（不是 400 + tool 字样也算）→ 不带工具重试一次，系统提示去掉联网那句；本 isolate 之后不再带工具', async () => {
  const seen = [];
  let ev;
  const lines = await withConsole(() => withFetch(async (u, init) => {
    const b = JSON.parse(init.body);
    seen.push(b);
    if (b.tools) return err(403, 'The caller does not have permission', 'PERMISSION_DENIED');
    return ok('好');
  }, async () => {
    ev = await events(await ask({ q: '主题', lang: 'zh' }, gEnv()));
    M._resetModelsCache(); R._resetCache();
    await events(await ask({ q: '主题', lang: 'zh' }, gEnv()));
  }));
  assert.deepEqual(ev.map((e) => e.event), ['delta', 'done']);
  assert.deepEqual(seen.map((b) => !!b.tools), [true, false, false], '第二次提问直接不带工具（整把钥匙记 10 分钟，不分模型）');
  assert.match(seen[0].systemInstruction.parts[0].text, /Google 搜索/);
  assert.doesNotMatch(seen[1].systemInstruction.parts[0].text, /Google 搜索/);
  assert.ok(lines.some((l) => l.includes('[ai] gemini search tool rejected')));
  _resetAndCheck();
});
function _resetAndCheck() {
  assert.equal(G.searchSuppressed('gemini-3.5-flash-lite'), true, '别的模型也不带');
  G._resetGeminiState();
  assert.equal(G.searchSuppressed(MODEL), false);
}

test('searchRejected：4xx 都算；429 / 404 / 401 / 地区 / 钥匙不算；5xx 不算', () => {
  assert.equal(G.searchRejected(400, 'Search Grounding is not supported.'), true);
  assert.equal(G.searchRejected(400, 'Request contains an invalid argument.'), true);
  assert.equal(G.searchRejected(403, 'PERMISSION_DENIED'), true);
  assert.equal(G.searchRejected(422, ''), true);
  assert.equal(G.searchRejected(429, ''), false);
  assert.equal(G.searchRejected(404, 'not found'), false);
  assert.equal(G.searchRejected(401, ''), false);
  assert.equal(G.searchRejected(400, 'User location is not supported for the API use.'), false);
  assert.equal(G.searchRejected(400, 'API key not valid. Please pass a valid API key.'), false);
  assert.equal(G.searchRejected(400, '{"status":"INVALID_ARGUMENT","details":[{"reason":"API_KEY_INVALID"}]}'), false);
  assert.equal(G.searchRejected(503, 'tool'), false);
  assert.equal(G.toolRejected(400, 'google_search tool not enabled'), true);
  assert.equal(G.retryableUpstream(503, ''), true);
  assert.equal(G.retryableUpstream(429, ''), true);
  assert.equal(G.retryableUpstream(400, 'UNAVAILABLE'), false);
});

test('地区不支持 / 钥匙无效：不重试、不去工具，一次就回', async () => {
  for (const [body, code] of [[err(400, 'User location is not supported for the API use.', 'FAILED_PRECONDITION'), 'region'], [err(400, 'API key not valid. Please pass a valid API key.', 'INVALID_ARGUMENT'), 'upstream']]) {
    M._resetModelsCache(); R._resetCache();
    let n = 0;
    let ev;
    await withConsole(() => withFetch(async () => { n++; return body.clone(); }, async () => { ev = await events(await ask({ q: '主题' }, gEnv())); }));
    assert.equal(n, 1);
    assert.equal(ev[0].data.code, code);
  }
});

test('空回答：只有思考 / 被截断 → [ai] gemini empty（finishReason + usage，脱敏）+ error empty，不当 done', async () => {
  let ev;
  const lines = await withConsole(() => withFetch(async () => new Response(
    sse({ candidates: [{ content: { parts: [{ text: '想了很久', thought: true }] } }] })
    + sse({ candidates: [{ content: { parts: [{ text: '', thoughtSignature: 'abc' }] }, finishReason: 'MAX_TOKENS' }], usageMetadata: { promptTokenCount: 900, thoughtsTokenCount: 4096, totalTokenCount: 4996, extra: 'AQ.Ab8RN6SECRETSECRETSECRET' } }),
    { status: 200 },
  ), async () => { ev = await events(await ask({ q: '主题' }, gEnv())); }));
  assert.deepEqual(ev, [{ event: 'error', data: { code: 'empty' } }]);
  const log = lines.find((l) => l.includes('[ai] gemini empty'));
  assert.ok(log, lines.join('\n'));
  assert.match(log, /"finishReason":"MAX_TOKENS"/);
  assert.match(log, /"thoughtsTokenCount":4096/);
  assert.match(log, /"search":true/);
  for (const l of lines) assert.doesNotMatch(l, /SECRETSECRET/);
  /* 空流（200 但一个字节都没有）也一样 */
  M._resetModelsCache(); R._resetCache();
  await withConsole(() => withFetch(async () => new Response('', { status: 200 }), async () => { ev = await events(await ask({ q: '主题' }, gEnv())); }));
  assert.deepEqual(ev, [{ event: 'error', data: { code: 'empty' } }]);
});

test('404 模型不可用：不重试、不去工具 → model_unavailable（2026-11-09 线上就是这一条）', async () => {
  let n = 0;
  let ev;
  const lines = await withConsole(() => withFetch(async () => { n++; return err(404, 'models/gemini-2.5-flash is no longer available to new users. Please use gemini-3.8-flash.', 'NOT_FOUND'); }, async () => {
    ev = await events(await ask({ q: '主题' }, gEnv()));
  }));
  assert.equal(n, 1);
  assert.equal(ev[0].data.code, 'model_unavailable');
  assert.match(lines.find((l) => l.includes('[ai] gemini upstream')), /"reason":"model"/);
});

test('退役 id：KV 里还是 gemini-2.5-flash → 展开成 3.5 Flash Lite（主力）+ 3.8 Flash；默认 / 浏览器存的旧选择按 Lite 认', async () => {
  const reg = M.parseModels({ default: 'gemini-2.5-flash', models: [{ id: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash', provider: 'gemini' }, { id: '@cf/google/gemma-4-26b-a4b-it', label: 'Gemma 4' }] });
  assert.deepEqual(reg.models.map((m) => [m.id, m.label]), [['gemini-3.5-flash-lite', 'Gemini 3.5 Flash Lite'], ['gemini-3.8-flash', 'Gemini 3.8 Flash'], ['@cf/google/gemma-4-26b-a4b-it', 'Gemma 4']]);
  assert.equal(reg.def, 'gemini-3.5-flash-lite');
  assert.equal(M.parseModels({ models: [{ id: 'gemini-2.5-flash', provider: 'gemini' }, { id: 'gemini-3.8-flash', provider: 'gemini' }] }).models.length, 2, '展开后去重');
  assert.deepEqual(M.pickModel(reg, 'gemini-2.5-flash', true), { ok: true, model: reg.models[0] });
  assert.deepEqual(M.pickModel(reg, 'gemini-3.8-flash', true), { ok: true, model: reg.models[1] });
  assert.deepEqual(M.pickModel(reg, 'gemini-9', true), { ok: false });
  const urls = [];
  await withFetch(async (u) => { urls.push(String(u)); return ok('好'); }, async () => {
    const res = await ask({ q: '主题', model: 'gemini-2.5-flash' }, gEnv({}, { default: '@cf/google/gemma-4-26b-a4b-it', models: [{ id: '@cf/google/gemma-4-26b-a4b-it' }, { id: 'gemini-2.5-flash', provider: 'gemini' }] }), { headers: { 'X-Styrigx-Account-Session': '1' } });
    assert.equal(res.headers.get('X-Styrigx-AI-Model'), 'gemini-3.5-flash-lite');
    await res.text();
  });
  assert.match(urls[0], /\/models\/gemini-3\.5-flash-lite:/);
});

test('redact：AQ. 格式的钥匙也遮掉；钥匙不进 URL', async () => {
  assert.equal(G.redact('bad key AQ.Ab8RN6IxYz0123456789_-abc end'), 'bad key [key] end');
  assert.equal(G.redact('AQ.short'), 'AQ.short', '太短的不算');
  assert.equal(G.redact('x AIzaSyA1234567890abcdefghijk y'), 'x [key] y');
  const seen = [];
  await withFetch(async (u, init) => { seen.push({ u: String(u), h: init.headers }); return ok('好'); }, async () => { await (await ask({ q: '主题' }, gEnv())).text(); });
  assert.doesNotMatch(seen[0].u, /AQ\./);
  assert.equal(seen[0].h['x-goog-api-key'], 'AQ.Ab8RN6SECRETSECRETSECRET');
});

test('浏览器断开：首字前的等待 / 重试立刻停，不再发请求', async () => {
  Object.assign(G.GEMINI_TIMING, { firstByteMs: 5000, backoffMs: [5, 5] });
  let n = 0;
  const ctl = new AbortController();
  await withConsole(() => withFetch(async (u, init) => { n++; setTimeout(() => ctl.abort(), 20); return new Response(hangingBody(init.signal), { status: 200 }); }, async () => {
    const res = await ask({ q: '主题' }, gEnv(), { signal: ctl.signal });
    const t0 = Date.now();
    try { await res.text(); } catch (e) { /* 断开时流可能报错 */ }
    assert.ok(Date.now() - t0 < 2000);
  }));
  assert.equal(n, 1);
});
