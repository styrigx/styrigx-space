/**
 * 从 Clash / mihomo 配置或 provider 文件里只抽 `proxies:`；规则、分组、DNS 等一律丢掉。
 * 源内重名加 ` #2`、` #3`（provider 里不能重名）；每项必须是有 name、type 的对象。
 */
import yaml from '../../lib/vendor/js-yaml.mjs';
import { ERR, MAX_NODES } from './config.js';

/**
 * @param {string} text
 * @returns {{ ok: true, proxies: Record<string, unknown>[] } | { ok: false, error: string }}
 */
export function extractProxies(text) {
  let doc;
  try {
    doc = yaml.load(String(text), { schema: yaml.CORE_SCHEMA, json: true });
  } catch (e) {
    return { ok: false, error: ERR.format };
  }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc) || !Array.isArray(doc.proxies)) return { ok: false, error: ERR.format };
  const out = [];
  const seen = new Map();
  for (const p of doc.proxies) {
    if (!p || typeof p !== 'object' || Array.isArray(p)) continue;
    if (typeof p.name !== 'string' || !p.name || typeof p.type !== 'string' || !p.type) continue;
    let name = p.name;
    const n = (seen.get(name) || 0) + 1;
    seen.set(p.name, n);
    if (n > 1) name = p.name + ' #' + n;
    out.push(name === p.name ? p : { ...p, name });
  }
  if (out.length === 0) return { ok: false, error: ERR.empty };
  if (out.length > MAX_NODES) return { ok: false, error: ERR.tooMany };
  return { ok: true, proxies: out };
}

/**
 * provider 文件正文：一行注释带生成时间，然后 JSON（YAML 的子集，mihomo 直接认），省掉 YAML 序列化的 CPU。
 * @param {Record<string, unknown>[]} proxies @param {number} gen
 */
export function providerText(proxies, gen) {
  return '# styrigx proxy-rules ' + new Date(gen).toISOString() + '\n' + JSON.stringify({ proxies }) + '\n';
}
