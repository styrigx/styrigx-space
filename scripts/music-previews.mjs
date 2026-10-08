// scripts/music-previews.mjs
// 在 hugo 构建前跑：用 iTunes lookup 取每首歌的 previewUrl，写入 data/music_previews.json
// 请求失败不让构建失败，沿用上次的值。
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const yamlPath = join(root, 'data', 'music.yaml');
const outPath = join(root, 'data', 'music_previews.json');

// 简单解析 music.yaml：只提取 apple_id / apple_country（按顺序）
function parseAppleIds(yaml) {
  const ids = [];
  let cur = null;
  for (const line of yaml.split('\n')) {
    if (/^- title:/.test(line)) {
      if (cur) ids.push(cur);
      cur = {};
    } else if (cur) {
      let m = line.match(/^\s+apple_id:\s*(\d+)/);
      if (m) cur.apple_id = m[1];
      m = line.match(/^\s+apple_country:\s*"?(us|tw|hk|jp)"?/);
      if (m) cur.apple_country = m[1];
    }
  }
  if (cur) ids.push(cur);
  return ids;
}

let prev = {};
if (existsSync(outPath)) {
  try { prev = JSON.parse(readFileSync(outPath, 'utf8')); } catch { prev = {}; }
}

const songs = parseAppleIds(readFileSync(yamlPath, 'utf8'));
const out = {};
let ok = 0, fail = 0;

for (let i = 0; i < songs.length; i++) {
  const s = songs[i];
  const key = String(i);
  if (!s.apple_id || !s.apple_country) {
    if (prev[key]) out[key] = prev[key]; // 保留旧值（理论上不应有）
    continue;
  }
  const url = `https://itunes.apple.com/lookup?id=${s.apple_id}&country=${s.apple_country}`;
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 15000);
    const res = await fetch(url, { signal: ctrl.signal, headers: { 'User-Agent': 'Mozilla/5.0' } });
    clearTimeout(t);
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const d = await res.json();
    const pu = d?.results?.[0]?.previewUrl;
    if (pu) { out[key] = pu; ok++; }
    else if (prev[key]) { out[key] = prev[key]; fail++; }
    else { fail++; }
  } catch (e) {
    if (prev[key]) out[key] = prev[key];
    fail++;
    console.error(`[music-previews] song ${i} failed: ${e.message}, kept previous`);
  }
  // 轻微节流
  await new Promise(r => setTimeout(r, 300));
}

writeFileSync(outPath, JSON.stringify(out, null, 2) + '\n');
console.log(`[music-previews] done: ${ok} ok, ${fail} failed/kept, ${songs.length} songs`);
