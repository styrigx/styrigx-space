/**
 * 从 Clash / mihomo 配置或 provider 文件里只抽 `proxies:`；规则、分组、DNS 等一律丢掉。
 * 机场源（opts.links）没有 `proxies:` 时再当节点链接列表（base64 或明文）读，见文末；一个都认不出仍报 ERR.format。上传文件不走这条。
 * 源内重名加 ` #2`、` #3`（provider 里不能重名）；每项必须是有 name、type 的对象。
 */
import yaml from '../../lib/vendor/js-yaml.mjs';
import { ERR, MAX_NODES } from './config.js';

/**
 * @param {string} text @param {{ links?: boolean }} [opts]
 * @returns {{ ok: true, proxies: Record<string, unknown>[] } | { ok: false, error: string }}
 */
export function extractProxies(text, opts = {}) {
  let doc = null;
  try {
    doc = yaml.load(String(text), { schema: yaml.CORE_SCHEMA, json: true });
  } catch (e) {
    doc = null;
  }
  let list;
  if (doc && typeof doc === 'object' && !Array.isArray(doc) && Array.isArray(doc.proxies)) list = doc.proxies;
  else {
    list = opts.links ? parseLinks(text) : [];
    if (list.length === 0) return { ok: false, error: ERR.format };
  }
  const out = [];
  const seen = new Map();
  for (const p of list) {
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

/* ---------- 节点链接列表 → mihomo 节点（定稿 §4 第 1 步，Gray 2026-11-12 01:01） ----------
 * 整段 base64 或明文，每行一个链接；只认 hysteria2（含 hy2）、vless、vmess、trojan、ss、tuic，认不出的行跳过。
 * 字段映射照 mihomo 自己的转换器 common/convert/converter.go、v.go（MetaCubeX/mihomo Meta 分支），
 * 只差一处：ws 头不带随机 User-Agent（Worker 输出要可复现）。重名由 extractProxies 统一加 ` #2`。
 */

/** @param {string} s @returns {string | null} 标准或 URL-safe、带不带 = 都认；不是 base64 回 null */
function b64(s) {
  const t = String(s).replace(/\s+/g, '');
  if (!t || !/^[A-Za-z0-9+/_-]*={0,2}$/.test(t)) return null;
  let u = t.replace(/-/g, '+').replace(/_/g, '/').replace(/=+$/, '');
  if (u.length % 4 === 1) return null;
  while (u.length % 4) u += '=';
  try {
    const bin = atob(u);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch (e) {
    return null;
  }
}

const SCHEMES = new Set(['hysteria2', 'hy2', 'vless', 'vmess', 'trojan', 'ss', 'tuic']);

/** @param {string} text @returns {Record<string, unknown>[]} */
function parseLinks(text) {
  const body = b64(text) ?? String(text);
  const out = [];
  for (const raw of body.split('\n')) {
    const line = raw.replace(/[ \r]+$/, '');
    const i = line.indexOf('://');
    if (i <= 0) continue;
    const scheme = line.slice(0, i).toLowerCase();
    if (!SCHEMES.has(scheme)) continue;
    let p = null;
    try {
      p = one(scheme, line, line.slice(i + 3));
    } catch (e) {
      p = null;
    }
    if (p) out.push(p);
  }
  return out;
}

/** @param {string} s */
function dec(s) {
  try { return decodeURIComponent(s); } catch (e) { return s; }
}

/** URL 拆件（WHATWG 对非特殊 scheme 的解析）；hostname 去掉 IPv6 方括号 */
function parse(line) {
  const u = new URL(line);
  return {
    host: u.hostname.replace(/^\[|\]$/g, ''),
    port: u.port,
    user: dec(u.username),
    pass: u.password ? dec(u.password) : null,
    q: u.searchParams,
    name: dec(u.hash.replace(/^#/, '')),
    path: u.pathname,
  };
}

const bool = (v) => v === '1' || /^(t|true)$/i.test(v || '');
const split = (v) => v.split(',');

function one(scheme, line, body) {
  switch (scheme) {
    case 'hysteria2':
    case 'hy2': return hy2(line);
    case 'tuic': return tuic(line);
    case 'trojan': return trojan(line);
    case 'vless': return vless(line);
    case 'vmess': return vmess(line, body);
    case 'ss': return ss(line);
  }
  return null;
}

/** 端口跳跃 host:443,5000-6000 → 先用第一个端口解析，ports 原样留 */
function hopPorts(line) {
  const i = line.indexOf('://');
  const head = line.slice(0, i + 3);
  const rest = line.slice(i + 3);
  const j = rest.search(/[/?#]/);
  let auth = j >= 0 ? rest.slice(0, j) : rest;
  const tail = j >= 0 ? rest.slice(j) : '';
  let userinfo = '';
  const at = auth.lastIndexOf('@');
  if (at >= 0) { userinfo = auth.slice(0, at + 1); auth = auth.slice(at + 1); }
  if (auth.includes(']')) return [line, ''];
  const c = auth.lastIndexOf(':');
  if (c < 0) return [line, ''];
  const host = auth.slice(0, c);
  const ports = auth.slice(c + 1);
  if (!/[,-]/.test(ports)) return [line, ''];
  const first = ports.split(/[,-]/)[0];
  if (!first) return [line, ''];
  return [head + userinfo + host + ':' + first + tail, ports];
}

function hy2(line) {
  const [hop, ports] = hopPorts(line);
  const u = parse(hop);
  const q = u.q;
  const p = { name: u.name, type: 'hysteria2', server: u.host, port: u.port || '443' };
  if (ports) p.ports = ports;
  p.obfs = q.get('obfs') || '';
  p['obfs-password'] = q.get('obfs-password') || '';
  p.sni = q.get('sni') || '';
  p['skip-cert-verify'] = bool(q.get('insecure'));
  if (q.get('alpn')) p.alpn = split(q.get('alpn'));
  p.fingerprint = q.get('pinSHA256') || '';
  p.down = q.get('down') || '';
  p.up = q.get('up') || '';
  const auth = u.pass != null ? u.user + ':' + u.pass : u.user;
  if (auth) p.password = auth;
  return p;
}

function tuic(line) {
  const u = parse(line);
  const q = u.q;
  const p = { name: u.name, type: 'tuic', server: u.host, port: u.port, udp: true };
  if (u.pass != null) { p.uuid = u.user; p.password = u.pass; } else p.token = u.user;
  if (q.get('congestion_control')) p['congestion-controller'] = q.get('congestion_control');
  if (q.get('alpn')) p.alpn = split(q.get('alpn'));
  if (q.get('sni')) p.sni = q.get('sni');
  if (q.get('disable_sni') === '1') p['disable-sni'] = true;
  if (q.get('udp_relay_mode')) p['udp-relay-mode'] = q.get('udp_relay_mode');
  return p;
}

function trojan(line) {
  const u = parse(line);
  const q = u.q;
  const p = { name: u.name, type: 'trojan', server: u.host, port: u.port, password: u.user, udp: true, 'skip-cert-verify': bool(q.get('allowInsecure')) };
  if (q.get('sni')) p.sni = q.get('sni');
  if (q.get('alpn')) p.alpn = split(q.get('alpn'));
  const net = (q.get('type') || '').toLowerCase();
  if (net) p.network = net;
  if (net === 'ws' || net === 'httpupgrade') {
    const ws = { path: q.get('path') || '', headers: {} };
    if (net === 'httpupgrade') { p.network = 'ws'; ws['v2ray-http-upgrade'] = true; }
    p['ws-opts'] = ws;
  } else if (net === 'grpc') {
    p['grpc-opts'] = { 'grpc-service-name': q.get('serviceName') || '' };
  }
  p['client-fingerprint'] = q.get('fp') || 'chrome';
  if (q.get('pcs')) p.fingerprint = q.get('pcs');
  return p;
}

/** Xray VMessAEAD / VLESS 分享链接（XTLS/Xray-core discussions 716），照 mihomo handleVShareLink */
function vshare(u, type) {
  if (!u.host || !u.port) return null;
  const q = u.q;
  const p = { name: u.name, type, server: u.host, port: u.port, uuid: u.user, udp: true };
  const sec = (q.get('security') || '').toLowerCase();
  if (sec.endsWith('tls') || sec === 'reality') {
    p.tls = true;
    p['client-fingerprint'] = q.get('fp') || 'chrome';
    if (q.get('alpn')) p.alpn = split(q.get('alpn'));
    if (q.get('pcs')) p.fingerprint = q.get('pcs');
  }
  if (q.get('sni')) p.servername = q.get('sni');
  if (q.get('pbk')) {
    const r = { 'public-key': q.get('pbk'), 'short-id': q.get('sid') || '' };
    const m = q.get('support-x25519mlkem768');
    if (m && /^(1|0|t|f|true|false)$/i.test(m)) r['support-x25519mlkem768'] = bool(m);
    p['reality-opts'] = r;
  }
  const pe = q.get('packetEncoding');
  if (pe === 'packet') p['packet-addr'] = true;
  else if (pe !== 'none') p.xudp = true;
  let net = (q.get('type') || '').toLowerCase() || 'tcp';
  const fake = (q.get('headerType') || '').toLowerCase();
  if (net === 'tcp' && fake === 'http') net = 'http';
  else if (net === 'http') net = 'h2';
  p.network = net;
  if (net === 'http') {
    const o = { path: [q.get('path') || '/'], headers: {} };
    if (q.get('host')) o.headers.Host = [q.get('host')];
    if (q.get('method')) o.method = q.get('method');
    p['http-opts'] = o;
  } else if (net === 'h2') {
    const o = { path: q.get('path') || '/' };
    if (q.get('host')) o.host = [q.get('host')];
    p['h2-opts'] = o;
  } else if (net === 'ws' || net === 'httpupgrade') {
    const ws = { path: q.get('path') || '', headers: { Host: q.get('host') || '' } };
    if (net === 'httpupgrade') { p.network = 'ws'; ws['v2ray-http-upgrade'] = true; }
    const ed = q.get('ed');
    if (ed) {
      if (!/^-?\d+$/.test(ed)) return null;
      if (net === 'ws') { ws['max-early-data'] = Number(ed); ws['early-data-header-name'] = 'Sec-WebSocket-Protocol'; } else ws['v2ray-http-upgrade-fast-open'] = true;
    }
    if (q.get('eh')) ws['early-data-header-name'] = q.get('eh');
    p['ws-opts'] = ws;
  } else if (net === 'grpc') {
    p['grpc-opts'] = { 'grpc-service-name': q.get('serviceName') || '' };
  } else if (net === 'xhttp') {
    const o = {};
    if (q.get('path')) o.path = q.get('path');
    if (q.get('host')) o.host = q.get('host');
    if (q.get('mode')) o.mode = q.get('mode');
    if (q.get('extra')) {
      try {
        const x = JSON.parse(q.get('extra'));
        if (x && typeof x === 'object' && !Array.isArray(x)) xhttpExtra(x, o);
      } catch (e) { /* 照 mihomo：extra 不是 JSON 就忽略 */ }
    }
    p['xhttp-opts'] = o;
  }
  return p;
}

function vless(line) {
  // 照 mihomo：host 段本身是 base64 时先解开
  const i = line.indexOf('://') + 3;
  const rest = line.slice(i);
  const j = rest.search(/[/?#]/);
  const auth = j >= 0 ? rest.slice(0, j) : rest;
  const at = auth.lastIndexOf('@');
  const host = auth.slice(at + 1);
  const d = /[:.\[]/.test(host) ? null : b64(host);
  const fixed = d ? line.slice(0, i) + auth.slice(0, at + 1) + d + (j >= 0 ? rest.slice(j) : '') : line;
  const u = parse(fixed);
  const p = vshare(u, 'vless');
  if (!p) return null;
  if (u.q.get('flow')) p.flow = u.q.get('flow').toLowerCase();
  if (u.q.get('encryption')) p.encryption = u.q.get('encryption');
  return p;
}

function vmess(line, body) {
  const js = b64(body.split('#')[0]);
  if (js == null) {
    const u = parse(line);
    const p = vshare(u, 'vmess');
    if (!p) return null;
    p.alterId = 0;
    p.cipher = u.q.get('encryption') || 'auto';
    return p;
  }
  let v;
  try { v = JSON.parse(js); } catch (e) { return null; }
  if (!v || typeof v !== 'object' || typeof v.ps !== 'string') return null;
  const p = { name: v.ps, type: 'vmess', server: v.add, port: v.port, uuid: v.id, alterId: 'aid' in v ? v.aid : 0, udp: true, xudp: true, tls: false, 'skip-cert-verify': false };
  p.cipher = typeof v.scy === 'string' && v.scy ? v.scy : 'auto';
  if (typeof v.sni === 'string' && v.sni) p.servername = v.sni;
  let net = '';
  if (typeof v.net === 'string') {
    net = v.net.toLowerCase();
    if (v.type === 'http') net = 'http';
    else if (net === 'http') net = 'h2';
    p.network = net;
  }
  if (typeof v.tls === 'string') {
    if (v.tls.toLowerCase().endsWith('tls')) p.tls = true;
    if (typeof v.alpn === 'string') p.alpn = split(v.alpn);
  }
  const host = typeof v.host === 'string' ? v.host : '';
  const path = typeof v.path === 'string' ? v.path : '';
  if (net === 'http') {
    const o = { path: [path || '/'], headers: {} };
    if (host) o.headers.Host = [host];
    p['http-opts'] = o;
  } else if (net === 'h2') {
    const o = { path: path || '/' };
    if (host) o.host = [host];
    p['h2-opts'] = o;
  } else if (net === 'ws' || net === 'httpupgrade') {
    const ws = { path: '/', headers: {} };
    if (net === 'httpupgrade') { p.network = 'ws'; ws['v2ray-http-upgrade'] = true; }
    if (host) ws.headers.Host = host;
    if (path) {
      let pth = path;
      try {
        const pu = new URL(path, 'http://x');
        const ed = pu.searchParams.get('ed');
        if (ed && /^-?\d+$/.test(ed)) {
          if (net === 'ws') { ws['max-early-data'] = Number(ed); ws['early-data-header-name'] = 'Sec-WebSocket-Protocol'; } else ws['v2ray-http-upgrade-fast-open'] = true;
          pu.searchParams.delete('ed');
          pth = pu.pathname + (pu.search || '');
        }
        if (pu.searchParams.get('eh')) ws['early-data-header-name'] = pu.searchParams.get('eh');
      } catch (e) { /* 照 mihomo：path 解析失败原样用 */ }
      ws.path = pth;
    }
    p['ws-opts'] = ws;
  } else if (net === 'grpc') {
    p['grpc-opts'] = { 'grpc-service-name': v.path };
  }
  return p;
}

function ss(line) {
  let u = parse(line);
  const name = u.name;
  if (!u.port) {
    // SIP002 之前的整段 base64：ss://base64(method:pass@host:port)#name
    const i = line.indexOf('://') + 3;
    const d = b64(line.slice(i).split(/[#?/]/)[0]);
    if (d == null) return null;
    u = parse('ss://' + d);
  }
  let cipher = u.user;
  let password = u.pass;
  if (password == null) {
    const d = b64(u.user);
    if (d == null) return null;
    const k = d.indexOf(':');
    if (k < 0) return null;
    cipher = d.slice(0, k);
    password = d.slice(k + 1);
  }
  const q = u.q;
  const p = { name, type: 'ss', server: u.host, port: u.port, cipher, password, udp: true };
  if (q.get('udp-over-tcp') === 'true' || q.get('uot') === '1') p['udp-over-tcp'] = true;
  const plugin = q.get('plugin') || '';
  if (plugin.includes(';')) {
    const info = new URLSearchParams('pluginName=' + plugin.replace(/;/g, '&'));
    const pn = info.get('pluginName') || '';
    if (pn.includes('obfs')) {
      p.plugin = 'obfs';
      p['plugin-opts'] = { mode: info.get('obfs') || '', host: info.get('obfs-host') || '' };
    } else if (pn.includes('v2ray-plugin')) {
      p.plugin = 'v2ray-plugin';
      p['plugin-opts'] = {
        mode: info.get('mode') || info.get('obfs') || '',
        host: info.get('host') || info.get('obfs-host') || '',
        path: info.get('path') || '',
        tls: plugin.includes('tls'),
      };
    }
  }
  return p;
}

/** xray extra JSON → mihomo xhttp-opts，照 mihomo parseXHTTPExtra */
function xhttpExtra(x, o) {
  const str = (v) => typeof v === 'string' && v !== '';
  const num = (v) => typeof v === 'number';
  const reuse = (m) => {
    const r = {};
    for (const [a, b] of [['maxConnections', 'max-connections'], ['maxConcurrency', 'max-concurrency'], ['cMaxReuseTimes', 'c-max-reuse-times'], ['hMaxRequestTimes', 'h-max-request-times'], ['hMaxReusableSecs', 'h-max-reusable-secs']]) {
      if (str(m[a])) r[b] = m[a];
      else if (num(m[a])) r[b] = String(Math.trunc(m[a]));
    }
    if (num(m.hKeepAlivePeriod)) r['h-keep-alive-period'] = Math.trunc(m.hKeepAlivePeriod);
    return r;
  };
  const obj = (v) => v && typeof v === 'object' && !Array.isArray(v);
  if (obj(x.headers) && Object.keys(x.headers).length) o.headers = x.headers;
  if (x.noGRPCHeader === true) o['no-grpc-header'] = true;
  if (str(x.xPaddingBytes)) o['x-padding-bytes'] = x.xPaddingBytes;
  if (typeof x.xPaddingObfsMode === 'boolean') o['x-padding-obfs-mode'] = x.xPaddingObfsMode;
  for (const [a, b] of [['xPaddingKey', 'x-padding-key'], ['xPaddingHeader', 'x-padding-header'], ['xPaddingPlacement', 'x-padding-placement'], ['xPaddingMethod', 'x-padding-method'], ['uplinkHTTPMethod', 'uplink-http-method']]) {
    if (str(x[a])) o[b] = x[a];
  }
  if (str(x.sessionIDPlacement)) o['session-placement'] = x.sessionIDPlacement;
  else if (str(x.sessionPlacement)) o['session-placement'] = x.sessionPlacement;
  if (str(x.sessionIDKey)) o['session-key'] = x.sessionIDKey;
  else if (str(x.sessionKey)) o['session-key'] = x.sessionKey;
  if (str(x.sessionIDTable)) o['session-table'] = x.sessionIDTable;
  if (str(x.sessionIDLength)) o['session-length'] = x.sessionIDLength;
  else if (num(x.sessionIDLength)) o['session-length'] = String(Math.trunc(x.sessionIDLength));
  for (const [a, b] of [['seqPlacement', 'seq-placement'], ['seqKey', 'seq-key'], ['uplinkDataPlacement', 'uplink-data-placement'], ['uplinkDataKey', 'uplink-data-key']]) {
    if (str(x[a])) o[b] = x[a];
  }
  for (const [a, b] of [['uplinkChunkSize', 'uplink-chunk-size'], ['scMaxEachPostBytes', 'sc-max-each-post-bytes'], ['scMinPostsIntervalMs', 'sc-min-posts-interval-ms']]) {
    if (num(x[a])) o[b] = Math.trunc(x[a]);
  }
  if (obj(x.xmux) && Object.keys(x.xmux).length) {
    const r = reuse(x.xmux);
    if (Object.keys(r).length) o['reuse-settings'] = r;
  }
  if (obj(x.downloadSettings)) {
    const s = x.downloadSettings;
    const ds = {};
    if (str(s.address)) ds.server = s.address;
    if (num(s.port)) ds.port = Math.trunc(s.port);
    const sec = typeof s.security === 'string' ? s.security.toLowerCase() : '';
    if (sec === 'tls' || sec === 'reality') {
      ds.tls = true;
      const t = s.tlsSettings;
      if (obj(t)) {
        if (str(t.serverName)) ds.servername = t.serverName;
        if (str(t.fingerprint)) ds['client-fingerprint'] = t.fingerprint;
        if (Array.isArray(t.alpn)) {
          const a = t.alpn.filter((v) => typeof v === 'string');
          if (a.length) ds.alpn = a;
        }
        if (t.allowInsecure === true) ds['skip-cert-verify'] = true;
      }
      if (sec === 'reality' && obj(s.realitySettings)) {
        const r = {};
        if (str(s.realitySettings.publicKey)) r['public-key'] = s.realitySettings.publicKey;
        if (str(s.realitySettings.shortId)) r['short-id'] = s.realitySettings.shortId;
        if (Object.keys(r).length) ds['reality-opts'] = r;
      }
    }
    const xs = s.xhttpSettings;
    if (obj(xs)) {
      if (str(xs.path)) ds.path = xs.path;
      if (str(xs.host)) ds.host = xs.host;
      if (obj(xs.headers) && Object.keys(xs.headers).length) ds.headers = xs.headers;
      if (obj(xs.extra) && obj(xs.extra.xmux) && Object.keys(xs.extra.xmux).length) {
        const r = reuse(xs.extra.xmux);
        if (Object.keys(r).length) ds['reuse-settings'] = r;
      }
    }
    if (Object.keys(ds).length) o['download-settings'] = ds;
  }
}
