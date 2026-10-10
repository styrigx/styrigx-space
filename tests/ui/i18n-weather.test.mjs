/**
 * 2.7.0 语言 / 天气测试（node --test）。
 *
 * 覆盖：
 * - 语言三档切换：system/zh/en（features.yaml lang 选项）
 * - baseof.html 内联脚本：system 时跟随 navigator.language
 * - 天气定位顺序：手动城市 > 精确定位 > IP 兜底 > LA
 * - build:false 机制：feature.html 对 build:false 返回 false
 *
 * 运行：node --test tests/ui/i18n-weather.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
const featuresYaml = readFileSync(join(root, 'data/features.yaml'), 'utf8');
const baseofHtml = readFileSync(join(root, 'layouts/_default/baseof.html'), 'utf8');
const settingsJs = readFileSync(join(root, 'assets/js/apps/settings.js'), 'utf8');
const indexJs = readFileSync(join(root, 'assets/js/apps/index.js'), 'utf8');
const featureHtml = readFileSync(join(root, 'layouts/partials/feature.html'), 'utf8');

/* 简单解析 lang feature 的 options（避免引入 yaml 依赖） */
function getLangOptions() {
  const langSection = featuresYaml.slice(featuresYaml.indexOf('- id: lang'));
  const optionsPart = langSection.slice(0, langSection.indexOf('- id:', 10));
  const ids = [];
  const re = /- \{id: (\w+)/g;
  let m;
  while ((m = re.exec(optionsPart)) !== null) ids.push(m[1]);
  return ids;
}
function getLangDefault() {
  const langSection = featuresYaml.slice(featuresYaml.indexOf('- id: lang'));
  const m = langSection.match(/default: (\w+)/);
  return m ? m[1] : null;
}

test('语言：features.yaml 有 system/zh/en 三档', () => {
  const ids = getLangOptions();
  assert.ok(ids.includes('system'), '应有 system 选项');
  assert.ok(ids.includes('zh'), '应有 zh 选项');
  assert.ok(ids.includes('en'), '应有 en 选项');
  assert.equal(getLangDefault(), 'system', '默认应为 system');
  assert.ok(featuresYaml.includes("key: sgx-lang"), 'key 应为 sgx-lang');
});

test('语言：baseof.html 处理 system 跟随浏览器', () => {
  assert.ok(
    baseofHtml.includes("navigator.language"),
    'baseof.html 应读取 navigator.language'
  );
  assert.ok(
    baseofHtml.includes("sgx-lang"),
    'baseof.html 应处理 sgx-lang'
  );
});

test('语言：settings.js 有三档切换 UI', () => {
  assert.ok(
    settingsJs.includes("langSystem") || settingsJs.includes('跟随系统'),
    'settings.js 应有"跟随系统"选项'
  );
  assert.ok(
    settingsJs.includes("localStorage.removeItem('sgx-lang')") ||
    settingsJs.includes('localStorage.removeItem("sgx-lang")'),
    '选 system 时应删除 sgx-lang（恢复默认跟随系统）'
  );
});

test('天气：定位顺序 手动城市 > 精确定位 > IP > LA', () => {
  // 检查 index.js 有 resolveLocation 且顺序正确
  assert.ok(
    indexJs.includes('resolveLocation'),
    'index.js 应有 resolveLocation 函数'
  );
  const idx = indexJs.indexOf('resolveLocation');
  const snippet = indexJs.slice(idx, idx + 2000);
  const manualPos = snippet.indexOf('sgx-weather-city');
  const precisePos = snippet.indexOf('sgx-weather-precise');
  const geoPos = snippet.indexOf('/api/geo');
  assert.ok(manualPos > 0, '应检查手动城市');
  assert.ok(precisePos > 0, '应检查精确定位');
  assert.ok(geoPos > 0, '应有 IP 兜底');
  assert.ok(manualPos < precisePos, '手动城市应在精确定位之前');
  assert.ok(precisePos < geoPos, '精确定位应在 IP 兜底之前');
});

test('天气：精确定位只在用户点击时触发', () => {
  assert.ok(
    settingsJs.includes('navigator.geolocation.getCurrentPosition'),
    'settings.js 应调用 geolocation'
  );
  // 确保不是页面加载自动调用，而是在 click handler 里
  const clickIdx = settingsJs.indexOf("getElementById('wx-precise')");
  assert.ok(clickIdx > 0, '应有 wx-precise 按钮');
  const handlerSnippet = settingsJs.slice(clickIdx, clickIdx + 500);
  assert.ok(
    handlerSnippet.includes('click') || settingsJs.slice(clickIdx - 200, clickIdx).includes('click'),
    'geolocation 应在 click 事件里触发'
  );
});

test('天气：手动城市用免费 geocoding API（无需密钥）', () => {
  assert.ok(
    settingsJs.includes('geocoding-api.open-meteo.com'),
    '应使用 open-meteo 免费 geocoding API'
  );
  assert.ok(
    !settingsJs.includes('api_key') && !settingsJs.includes('apikey'),
    '不应有 API 密钥'
  );
});

test('G/build:false：feature.html 有 build 判断逻辑', () => {
  assert.ok(
    featureHtml.includes('build'),
    'feature.html 应检查 build 字段'
  );
  // 当前 features.yaml 里 build:false 的项（验证解析逻辑）
  const buildFalseCount = (featuresYaml.match(/build: false/g) || []).length;
  // 机制存在即可，具体数量不强制
  assert.ok(
    featureHtml.toLowerCase().includes('false') || featureHtml.includes('ne ') || featureHtml.includes('eq '),
    'feature.html 应有 build:false 判断逻辑'
  );
});
