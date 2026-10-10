/**
 * 临时自检接口：GET /api/diag/session（请求头 X-Diag-Token: <DIAG_TOKEN>）
 * 诊断会话签发/验证配置。定位问题后删除本文件及 middleware 里的临时放行。
 *
 * 保护：X-Diag-Token 必须等于 env.DIAG_TOKEN（常量时间比较），否则 404；
 * DIAG_TOKEN 未设置也 404。
 * 只返回布尔值、长度、格式名，绝不返回密钥内容、cookie 值。
 */
import { timingSafeEqual, b64dec } from '../../_lib/crypto.js';
import { SESSION_COOKIE, COOKIE_ATTRS, SESSION_MAX_AGE } from '../../_lib/session.js';
import { verifySessionReason, READER_COOKIE_NAME } from '../../_middleware.js';

const DIAG_PAYLOAD = 'sgx-diag-test';

/* 识别密钥格式（只看结构，不返回内容） */
function detectFormat(v, kind) {
  if (!v) return 'missing';
  if (kind === 'private' && v.includes('-----BEGIN PRIVATE KEY-----')) return 'PEM-PKCS8';
  if (kind === 'public' && v.includes('-----BEGIN PUBLIC KEY-----')) return 'PEM-SPKI';
  const compact = v.replace(/\s/g, '');
  try {
    let b64 = compact.replace(/-/g, '+').replace(/_/g, '/');
    while (b64.length % 4) b64 += '=';
    const raw = b64dec(b64);
    if (raw.byteLength === 32) return 'raw32';
    return 'base64';
  } catch (e) {
    return 'unknown';
  }
}

/* 与生产代码同路径剥 PEM 头 */
function stripPem(v) {
  return v.replace(/-----[^-]+-----/g, '').replace(/\s/g, '');
}

async function tryImportPrivate(pem) {
  try {
    const der = b64dec(stripPem(pem));
    await crypto.subtle.importKey('pkcs8', der, { name: 'Ed25519' }, false, ['sign']);
    return true;
  } catch (e) {
    return false;
  }
}

async function tryImportPublic(pem) {
  try {
    const der = b64dec(stripPem(pem));
    await crypto.subtle.importKey('spki', der, { name: 'Ed25519' }, false, ['verify']);
    return true;
  } catch (e) {
    return false;
  }
}

async function tryRoundtrip(privPem, pubPem) {
  try {
    const derPriv = b64dec(stripPem(privPem));
    const derPub = b64dec(stripPem(pubPem));
    const privKey = await crypto.subtle.importKey('pkcs8', derPriv, { name: 'Ed25519' }, false, ['sign']);
    const pubKey = await crypto.subtle.importKey('spki', derPub, { name: 'Ed25519' }, false, ['verify']);
    const data = new TextEncoder().encode(DIAG_PAYLOAD);
    const sig = await crypto.subtle.sign('Ed25519', privKey, data);
    return await crypto.subtle.verify('Ed25519', pubKey, sig, data);
  } catch (e) {
    return false;
  }
}

/* 从 COOKIE_ATTRS 常量解析属性（不带值） */
function parseCookieAttrs() {
  const out = {
    name: SESSION_COOKIE,
    domain: '',
    path: '',
    samesite: '',
    secure: false,
    httponly: false,
    max_age: SESSION_MAX_AGE,
  };
  for (const part of COOKIE_ATTRS.split(';')) {
    const p = part.trim();
    const eq = p.indexOf('=');
    const k = (eq >= 0 ? p.slice(0, eq) : p).toLowerCase();
    const v = eq >= 0 ? p.slice(eq + 1) : '';
    if (k === 'domain') out.domain = v;
    else if (k === 'path') out.path = v;
    else if (k === 'samesite') out.samesite = v;
    else if (k === 'secure') out.secure = true;
    else if (k === 'httponly') out.httponly = true;
  }
  return out;
}

function hasCookie(request, name) {
  const h = request.headers.get('Cookie') || '';
  for (const part of h.split(';')) {
    const k = part.trim().split('=')[0];
    if (k === name) return true;
  }
  return false;
}

/** @param {any} context */
export async function onRequestGet(context) {
  const { request, env } = context;
  const diagToken = (env && env.DIAG_TOKEN) || '';
  const token = request.headers.get('X-Diag-Token') || '';
  if (!diagToken || !token || !(await timingSafeEqual(token, diagToken))) {
    return new Response('Not Found', { status: 404 });
  }

  const priv = (env && env.SGX_ED25519_PRIVATE) || '';
  const pub = (env && env.SGX_ED25519_PUBLIC) || '';
  const privPresent = !!priv;
  const pubPresent = !!pub;
  const hadCookie = hasCookie(request, SESSION_COOKIE);

  const out = {
    ok: true,
    private_present: privPresent,
    public_present: pubPresent,
    private_format: detectFormat(priv, 'private'),
    public_format: detectFormat(pub, 'public'),
    private_len: priv.length,
    public_len: pub.length,
    private_import_ok: privPresent ? await tryImportPrivate(priv) : false,
    public_import_ok: pubPresent ? await tryImportPublic(pub) : false,
    roundtrip_ok: privPresent && pubPresent ? await tryRoundtrip(priv, pub) : false,
    writer_reader_cookie_name_match: SESSION_COOKIE === READER_COOKIE_NAME,
    set_cookie_attrs: parseCookieAttrs(),
    request_had_cookie: hadCookie,
    expected_cookie_name: SESSION_COOKIE,
  };
  if (hadCookie) {
    const reason = await verifySessionReason(request, env);
    out.verify_result = reason === 'ok';
    out.verify_fail_reason = reason === 'ok' ? null : reason;
  }
  return Response.json(out);
}
