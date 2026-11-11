/**
 * POST /api/identity —— v6 身份命令（P2，定稿 v4 §六 / §八 / §十；命令手册 docs/specs/v6-identity-migration.md 与终端 P2b）。
 *
 * 请求：{ action, ... }，JSON，必须同源。每个 action 一档，档在 core/route-access.js 的 /api/identity 行（唯一权限来源），
 * 判断只经 core/groups.js permits（顺序：救援 → root → 档）；救援会话只放 rescueActions 里的几个。
 *
 * | action                   | 档      | 做什么 |
 * |--------------------------|---------|--------|
 * | whoami                   | public  | 当前身份（访客 user:null）；顺手做滑动续期 |
 * | su-challenge / su        | public  | su <用户>：访客 → 普通用户（输对方的密码或通行密钥；root 一律拒——root 代码级禁止公开登录）；
 * |                          |         | su root：仅 wheel，输 root 的凭据，压 root 层（≤ 1 小时）。普通用户态不能 su 到另一个普通用户（exit-first） |
 * | exit                     | public  | 弹一层：root → 普通用户 → 访客；救援直接回访客 |
 * | idle                     | public  | 前台空闲 15 分钟（前端 Page Visibility 计时）：只弹 root 层，普通用户层不动 |
 * | lock                     | public  | 清空整个栈并删服务端会话行 |
 * | passwd                   | user    | 改自己的密码：先输当前密码（救援会话免）；自己改 → 当前会话续命、其他会话作废 |
 * | passkey-*                | user    | 自己的通行密钥 ls / add / rm（改了 → epoch +1，当前会话续命） |
 * | groups                   | user    | 自己的组；root 可 groups <名> |
 * | who                      | user    | 会话与身份路径（root via styrigx）；普通用户只看自己，root 看全部 |
 * | sudo-challenge / sudo    | sudoers | 每次输自己的凭据，借 root 执行一条（useradd / userdel / usermod / passwd <名> / groups <名> / who）；不发票据、不压栈；
 * |                          |         | 不能动 root 的凭据（passwd / passkey 一律拒） |
 * | （sudo，P2c）            | sudoers | command = { method, path, body? }：借 root 执行账号 Worker 里任何一条接口（api/sudo-route.js）；
 * |                          |         | 同样每次验自己的凭据、不发票据、不压栈；root 的凭据接口（/api/account/keys、reset）与身份接口本身拒绝 |
 * | useradd / userdel / usermod / passwd-user | root | 用户管理（core/user-admin.js） |
 * | rescue（P3）             | public  | 救援入口（定稿 v5.2 §九，core/rescue.js）：访客输恢复钥匙 → 15 分钟一次性 root 会话（rescue 标志、不续期）；
 * |                          |         | 已登录 → exit-first；救援会话里再调 → permits 第 1 步拒（rescue 不在白名单） |
 *
 * uid 只取服务端会话（ADR-0006 §2.12 (a)）：请求体里的 uid / user 只当命令参数（目标用户名），从不当「我是谁」。
 * 审计（core/user-audit.js）：su / sudo / exit / idle / lock / passwd / passkey / useradd / userdel / usermod、登录失败（login-fail）。
 * 密码、一次性密码一律不进审计、不进日志。
 */
import { isSameOrigin, originDenied, json, apiError, clientIp } from '../lib/http.js';
import { readCookie } from '../lib/cookies.js';
import { levelOf, rescueOf } from '../core/route-access.js';
import { permits, ROOT_UID, STYRIGX_UID, USER_NAME_RE, ACCESS } from '../core/groups.js';
import { admitRequest, SESSION_COOKIE, ROOT_IDLE_MS, SESSION_TTL_MS } from '../core/identity-session.js';
import { getUser, getGroups, isUserActive, credentialsChanged } from '../core/users.js';
import { writeUserAudit } from '../core/user-audit.js';
import { verifyUserPassword, savePasswordFor, passwordAcceptable } from '../core/identity-auth.js';
import { issueSession, pushRootLayer, popRootLayer, hasRootLayer, endSession, endSessionByToken, clearSessionCookie as clearSid, renewSession, markerCookie, clearMarkerCookie } from '../core/identity-stack.js';
import { useradd, userdel, usermod, passwdReset, groupsOf, whoList, userByName } from '../core/user-admin.js';
import { V6_PURPOSE, v6AssertionChallenge, v6CheckAssertion, v6RegistrationChallenge, v6AddPasskey, v6PasskeyViews, v6DeletePasskey } from '../core/identity-passkey.js';
import { rpConfig, rpConfigMissing } from '../core/config.js';
import { sudoTarget, runSudoRoute } from './sudo-route.js';
import { rescue as rescueIssue } from '../core/rescue.js';
import { deviceMarkFor, deviceCookie } from '../core/device-mark.js';

const PATH = '/api/identity';
const BODY_MAX = 16 * 1024;
/** sudo 能借 root 执行的命令（不含 passwd / passkey：sudo 夺不走 root 的凭据） */
export const SUDO_COMMANDS = Object.freeze(['useradd', 'userdel', 'usermod', 'passwd-user', 'groups', 'who']);

/** 审计里的参数：只留名字 / 组 / 日期这类非秘密字符（截长） @param {any} v */
function arg(v) {
  return String(v === undefined || v === null ? '' : v).replace(/[^a-z0-9,\-:]/gi, '').slice(0, 64);
}

/**
 * 给前端的身份视图（访客 null）。
 * @param {any} adm admitSession 的结果
 */
function view(adm) {
  if (!adm || !adm.ok) return null;
  const id = adm.identity;
  return {
    uid: id.uid, name: id.name, groups: id.uid === ROOT_UID ? [] : id.groups.slice(), root: id.uid === ROOT_UID, rescue: id.rescue === true,
    via: adm.via ? adm.via.name : '', path: id.rescue ? 'root (rescue)' : adm.via ? id.name + ' via ' + adm.via.name : id.name,
    owner: id.uid === STYRIGX_UID, wheel: id.groups.indexOf('wheel') !== -1, sudoers: id.groups.indexOf('sudoers') !== -1,
    layerExpiresAt: adm.layerExpiresAt, idleMs: adm.via ? ROOT_IDLE_MS : 0,
  };
}

/** 清会话 cookie + 登录标记 @param {Headers} h */
function clearAll(h) {
  h.append('Set-Cookie', clearSid());
  h.append('Set-Cookie', clearMarkerCookie());
}

/** @param {any} body @param {Headers} [h] */
function ok(body, h) {
  return json(200, Object.assign({ ok: true }, body), h);
}

/** 凭据错误统一映射（防枚举：只有 auth / cooldown / server / config 四种） @param {string} e */
function credError(e) {
  if (e === 'cooldown') return apiError(429, 'cooldown');
  if (e === 'config') return apiError(503, 'config');
  if (e === 'server') return apiError(503, 'server');
  return apiError(401, 'auth');
}

/**
 * 验「这个人」的凭据：password 或 { cid, credential }（通行密钥）。永不抛错。
 * @param {any} env @param {string} ip @param {any} body @param {{uid?:number, name?:string}} who @param {string} purpose 通行密钥 challenge 用途
 * @returns {Promise<{ok:true, uid:number, mustChange:boolean, by:'password'|'passkey'}|{ok:false, error:string}>}
 */
async function verifyCreds(env, ip, body, who, purpose) {
  if (body && body.credential) {
    const rp = rpConfig(env);
    if (!rp) return { ok: false, error: 'config' };
    let expect = typeof who.uid === 'number' ? who.uid : null;
    if (expect === null) {
      try { const u = await userByName(env, String(who.name || '')); expect = u ? u.uid : -1; } catch (e) { return { ok: false, error: 'server' }; }
    }
    const r = await v6CheckAssertion(env, rp, purpose, body, expect);
    if (!r.ok) return { ok: false, error: 'auth' };
    let u = null;
    try { u = await getUser(env, r.uid); } catch (e) { return { ok: false, error: 'server' }; }
    if (!isUserActive(u, Date.now())) return { ok: false, error: 'auth' };
    return { ok: true, uid: r.uid, mustChange: false, by: 'passkey' };
  }
  const r = await verifyUserPassword(env, typeof who.uid === 'number' ? { ip, uid: who.uid, password: body && body.password } : { ip, name: String(who.name || ''), password: body && body.password });
  if (!r.ok) return r;
  return { ok: true, uid: r.uid, mustChange: r.mustChange, by: 'password' };
}

/**
 * 用户管理命令（root 直接执行，或 sudo 借 root 执行）。回 { res, audit }。
 * @param {any} env @param {string} action @param {any} q @param {{identity:any, sessionId:string, sudo:boolean}} ctx
 */
async function runAdmin(env, action, q, ctx) {
  const now = Date.now();
  if (action === 'useradd') {
    const r = await useradd(env, { name: q.name, expire: q.expire, groups: q.groups }, now);
    const audit = 'useradd ' + arg(q.name) + (q.expire ? ' -e ' + arg(q.expire) : '') + (q.groups ? ' -G ' + arg(Array.isArray(q.groups) ? q.groups.join(',') : q.groups) : '');
    if (!r.ok) return { res: adminError(r), audit, ok: false };
    return { res: ok({ user: { uid: r.uid, name: r.name, groups: r.groups, expiresAt: r.expiresAt }, password: r.password, passwordExpiresAt: r.passwordExpiresAt, mustChange: true }), audit, ok: true };
  }
  if (action === 'userdel') {
    const r = await userdel(env, q.name);
    const audit = 'userdel ' + arg(q.name);
    if (!r.ok) return { res: adminError(r), audit, ok: false };
    return { res: ok({ uid: r.uid }), audit, ok: true };
  }
  if (action === 'usermod') {
    const r = await usermod(env, { name: q.name, op: q.op, groups: q.groups, force: q.force === true }, now);
    const audit = 'usermod ' + arg(q.op) + ' ' + arg(Array.isArray(q.groups) ? q.groups.join(',') : q.groups) + ' ' + arg(q.name);
    if (!r.ok) return { res: adminError(r), audit, ok: false };
    return { res: ok(Object.assign({ changed: r.changed }, r.warning ? { warning: r.warning } : {})), audit, ok: true };
  }
  if (action === 'passwd-user') {
    const r = await passwdReset(env, q.name, now);
    const audit = 'passwd ' + arg(q.name);
    if (!r.ok) return { res: adminError(r), audit, ok: false };
    return { res: ok({ uid: r.uid, password: r.password, passwordExpiresAt: r.passwordExpiresAt, mustChange: true }), audit, ok: true };
  }
  if (action === 'groups') {
    const g = typeof q.user === 'string' && q.user ? await groupsOf(env, q.user) : { name: 'root', uid: ROOT_UID, groups: ['root'] };
    if (!g) return { res: apiError(404, 'not-found'), audit: '', ok: false };
    return { res: ok(g), audit: '', ok: true };
  }
  if (action === 'who') {
    return { res: ok({ sessions: await whoList(env, { onlyUid: null, current: ctx.sessionId, now }) }), audit: '', ok: true };
  }
  return { res: apiError(400, 'action'), audit: '', ok: false };
}

/** @param {{error:string, group?:string}} r */
function adminError(r) {
  const extra = r.group ? { group: r.group } : undefined;
  switch (r.error) {
    case 'name': return apiError(400, 'name', extra);
    case 'expiry': return apiError(400, 'expiry', extra);
    case 'temporary': return apiError(400, 'temporary', extra);
    case 'group': return apiError(400, 'group', extra);
    case 'action': return apiError(400, 'action');
    case 'params': return apiError(400, 'params', extra);
    case 'exists': return apiError(403, 'exists', extra);
    case 'no-user': return apiError(404, 'not-found', extra);
    case 'protected-root': return apiError(403, 'protected', { target: 'root' });
    case 'protected-owner': return apiError(403, 'protected', { target: 'owner' });
    case 'last-member': return apiError(409, 'last-member', extra);
    case 'root-creds': return apiError(403, 'root-creds');
    default: return apiError(503, 'server');
  }
}

/** @param {any} context */
export async function onRequestPost(context) {
  const { request, env } = context;
  try {
    if (!isSameOrigin(request)) return originDenied();
    let text = '';
    try { text = await request.text(); } catch (e) { return apiError(400, 'body'); }
    if (text.length > BODY_MAX) return apiError(413, 'too-large');
    let body;
    try { body = JSON.parse(text || '{}'); } catch (e) { return apiError(400, 'body'); }
    if (!body || typeof body !== 'object' || Array.isArray(body)) return apiError(400, 'body');
    const action = typeof body.action === 'string' ? body.action : '';
    const level = action ? levelOf('POST', PATH, { action }) : null;
    if (!level) return apiError(400, 'action');
    const token = readCookie(request, SESSION_COOKIE) || '';
    const adm = token ? await admitRequest(env, request) : { ok: false, reason: 'no-cookie' };
    if (!adm.ok && adm.reason === 'error') return apiError(503, 'server');
    const identity = adm.ok ? adm.identity : null;
    if (!permits(identity, level, { rescue: rescueOf('POST', PATH, { action }) })) {
      return identity ? apiError(403, 'permission', { need: level }) : apiError(401, 'unauthorized');
    }
    const ip = clientIp(request);
    const audit = (command, okFlag, uid) => writeUserAudit(env, { uid: uid === undefined ? (identity ? identity.uid : null) : uid, command, ok: okFlag, ip });
    return await dispatch({ env, request, body, action, adm, identity, token, ip, audit, context });
  } catch (e) {
    console.error('[api/identity] unhandled: ' + (e && /** @type {any} */ (e).name ? /** @type {any} */ (e).name : 'error'));
    return apiError(500, 'internal');
  }
}

/**
 * @param {{env:any, request:Request, body:any, action:string, adm:any, identity:any, token:string, ip:string,
 *   audit:(command:string, ok:boolean, uid?:number|null)=>Promise<boolean>, context:any}} c
 */
async function dispatch(c) {
  const { env, body, action, adm, identity, token, ip, audit } = c;
  const now = Date.now();
  switch (action) {
    case 'whoami': {
      const h = new Headers();
      if (adm.ok && adm.renew) {
        const ck = await renewSession(env, adm.sessionId, token, now);
        if (ck) { h.append('Set-Cookie', ck); h.append('Set-Cookie', markerCookie(SESSION_TTL_MS.user / 1000)); }
      } else if (!adm.ok && (token || /(?:^|;\s*)sgx-id=/.test(c.request.headers.get('Cookie') || ''))) {
        clearAll(h); /* 失效的令牌 / 残留的标记顺手清掉 */
      }
      return ok({ user: view(adm) }, h);
    }

    case 'su-challenge':
    case 'sudo-challenge': {
      const rp = rpConfig(env);
      if (!rp) return rpConfigMissing();
      try {
        return ok(await v6AssertionChallenge(env, rp, action === 'su-challenge' ? V6_PURPOSE.su : V6_PURPOSE.sudo));
      } catch (e) { return apiError(500, 'server'); }
    }

    case 'su': {
      const target = typeof body.user === 'string' ? body.user.trim() : '';
      if (target === 'root') {
        if (!identity) return apiError(403, 'permission', { need: 'wheel' }); /* root 代码级禁止公开登录 */
        if (identity.uid === ROOT_UID) return apiError(409, 'already-root');
        if (!permits(identity, 'wheel')) return apiError(403, 'permission', { need: 'wheel' });
        const v = await verifyCreds(env, ip, body, { uid: ROOT_UID }, V6_PURPOSE.su);
        if (!v.ok) { await audit('login-fail su root', false); return credError(v.error); }
        const root = await getUser(env, ROOT_UID);
        if (!root) return apiError(503, 'server');
        await pushRootLayer(env, adm.sessionId, root.epoch, adm.expiresAt, now);
        await audit('su root', true);
        return ok({ user: view(await admitRequest(env, c.request)) });
      }
      if (identity) return apiError(409, 'exit-first');
      if (token) { try { await endSessionByToken(env, token); } catch (e) {} } /* 失效的旧令牌：行一起清 */
      if (!USER_NAME_RE.test(target)) { await audit('login-fail su', false, null); return credError('auth'); }
      const v = await verifyCreds(env, ip, body, { name: target }, V6_PURPOSE.su);
      if (!v.ok) { await audit('login-fail su ' + arg(target), false, null); return credError(v.error); }
      if (v.uid === ROOT_UID) return apiError(403, 'permission', { need: 'wheel' });
      if (v.mustChange) {
        if (body.newPassword === undefined) return apiError(403, 'must-change');
        if (!passwordAcceptable(body.newPassword, target) || body.newPassword === body.password) return apiError(400, 'weak');
        await savePasswordFor(env, v.uid, body.newPassword, { mustChange: false });
        await credentialsChanged(env, v.uid, {});
        await audit('passwd first-login', true, v.uid);
      }
      const u = await getUser(env, v.uid);
      if (!u) return credError('auth');
      const mark = deviceMarkFor(c.request); /* 2g：同一台设备沿用 sgx-device，没有就新发（定稿 v5.5 §十一） */
      const s = await issueSession(env, { uid: u.uid, epoch: u.epoch }, now, { device: mark });
      await audit('su ' + arg(target), true, u.uid);
      const h = new Headers();
      h.append('Set-Cookie', s.cookie);
      h.append('Set-Cookie', deviceCookie(mark));
      h.append('Set-Cookie', markerCookie(SESSION_TTL_MS.user / 1000));
      const groups = await getGroups(env, u.uid);
      return ok({ user: view({ ok: true, identity: { uid: u.uid, name: u.name, groups, rescue: false }, via: null, layerExpiresAt: s.expiresAt }) }, h);
    }

    case 'rescue': {
      /* 定稿 v5.2 §九：访客走救援入口（已登录先 exit，同 su 的 exit-first） */
      if (identity) return apiError(409, 'exit-first');
      if (token) { try { await endSessionByToken(env, token); } catch (e) {} } /* 失效的旧令牌：行一起清 */
      const r = await rescueIssue(env, { ip, key: body.key, now });
      if (!r.ok) {
        if (r.audit) await audit(r.audit, false, null);
        return credError(r.error);
      }
      await audit('rescue', true, ROOT_UID);
      const h = new Headers();
      h.append('Set-Cookie', r.cookie);
      h.append('Set-Cookie', markerCookie(SESSION_TTL_MS.rescue / 1000));
      return ok({ user: view({ ok: true, identity: { uid: ROOT_UID, name: 'root', groups: [], rescue: true }, via: null, layerExpiresAt: r.expiresAt }) }, h);
    }

    case 'exit': {
      const h = new Headers();
      if (!adm.ok) {
        if (token) clearAll(h);
        return ok({ user: null }, h);
      }
      if (!identity.rescue && (await hasRootLayer(env, adm.sessionId))) {
        await popRootLayer(env, adm.sessionId);
        await audit('exit root', true);
        return ok({ user: view(await admitRequest(env, c.request)) });
      }
      await endSession(env, adm.sessionId);
      clearAll(h);
      await audit('exit', true);
      return ok({ user: null }, h);
    }

    case 'idle': {
      if (adm.ok && !identity.rescue && adm.via && (await hasRootLayer(env, adm.sessionId))) {
        await popRootLayer(env, adm.sessionId);
        await audit('idle root', true);
        return ok({ user: view(await admitRequest(env, c.request)), popped: true });
      }
      return ok({ user: view(adm), popped: false });
    }

    case 'lock': {
      const h = new Headers();
      if (token) {
        await endSessionByToken(env, token);
      }
      clearAll(h);
      if (identity) await audit('lock', true);
      return ok({ user: null }, h);
    }

    case 'passwd': {
      if (typeof body.user === 'string' && body.user && body.user !== identity.name) return apiError(400, 'target');
      if (!identity.rescue) {
        const v = await verifyUserPassword(env, { ip, uid: identity.uid, password: body.current });
        if (!v.ok) { await audit('login-fail passwd', false); return credError(v.error); }
      }
      if (!passwordAcceptable(body.password, identity.name) || body.password === body.current) return apiError(400, 'weak');
      await savePasswordFor(env, identity.uid, body.password, { mustChange: false });
      await credentialsChanged(env, identity.uid, { sessionId: adm.sessionId });
      await audit(identity.rescue ? 'passwd rescue' : 'passwd', true);
      return ok({});
    }

    case 'passkey-list':
      return ok({ passkeys: await v6PasskeyViews(env, identity.uid) });

    case 'passkey-add-challenge': {
      const rp = rpConfig(env);
      if (!rp) return rpConfigMissing();
      return ok(await v6RegistrationChallenge(env, rp, { uid: identity.uid, name: identity.name }));
    }

    case 'passkey-add': {
      const rp = rpConfig(env);
      if (!rp) return rpConfigMissing();
      const r = await v6AddPasskey(env, rp, { uid: identity.uid }, body);
      if (!r.ok) { await audit('passkey add', false); return r.error === 'challenge' ? apiError(403, 'challenge') : apiError(403, 'verify'); }
      await credentialsChanged(env, identity.uid, { sessionId: adm.sessionId });
      await audit('passkey add', true);
      return ok({ credId: r.credId });
    }

    case 'passkey-delete': {
      const n = Number(body.n);
      const done = await v6DeletePasskey(env, identity.uid, n);
      if (!done) return apiError(404, 'not-found');
      await credentialsChanged(env, identity.uid, { sessionId: adm.sessionId });
      await audit('passkey rm ' + arg(n), true);
      return ok({});
    }

    case 'groups': {
      const target = typeof body.user === 'string' && body.user ? body.user : identity.name;
      if (target !== identity.name && !(identity.uid === ROOT_UID && !identity.rescue)) return apiError(403, 'permission', { need: ACCESS.ROOT });
      if (target === identity.name) return ok({ name: identity.name, uid: identity.uid, groups: identity.uid === ROOT_UID ? ['root'] : identity.groups.slice() });
      const g = await groupsOf(env, target);
      return g ? ok(g) : apiError(404, 'not-found');
    }

    case 'who': {
      const all = identity.uid === ROOT_UID && !identity.rescue;
      const onlyUid = all ? null : (adm.via ? adm.via.uid : identity.uid);
      return ok({ sessions: await whoList(env, { onlyUid, current: adm.sessionId, now }) });
    }

    case 'sudo': {
      const cmd = body.command && typeof body.command === 'object' ? body.command : {};
      if (typeof cmd.path === 'string' || typeof cmd.method === 'string') {
        /* P2c：sudo 借 root 执行账号 Worker 里任何一条接口（api/sudo-route.js）；同样每次验自己的凭据、不发票据、不压栈 */
        const tg = sudoTarget(cmd, c.context && c.context.routes);
        if (!tg.ok) return apiError(tg.status, tg.error);
        const v = await verifyCreds(env, ip, body, { uid: identity.uid }, V6_PURPOSE.sudo);
        if (!v.ok) { await audit('login-fail sudo', false); return credError(v.error); }
        const res = await runSudoRoute(c.context, tg, { uid: identity.uid, name: identity.name }, adm.sessionId);
        await audit('sudo ' + tg.method + ' ' + tg.path.replace(/[^a-z0-9/\-]/gi, '').slice(0, 64) + (tg.action ? ' ' + arg(tg.action) : ''), res.status < 400);
        return res;
      }
      const sub = typeof cmd.action === 'string' ? cmd.action : '';
      if (sub === 'passwd' || sub.startsWith('passkey')) return apiError(403, 'root-creds'); /* sudo 不能动 root 的凭据 */
      if (SUDO_COMMANDS.indexOf(sub) === -1) return apiError(400, 'action');
      const v = await verifyCreds(env, ip, body, { uid: identity.uid }, V6_PURPOSE.sudo);
      if (!v.ok) { await audit('login-fail sudo', false); return credError(v.error); }
      const r = await runAdmin(env, sub, cmd, { identity, sessionId: adm.sessionId, sudo: true });
      await audit('sudo ' + (r.audit || sub), r.ok);
      return r.res;
    }

    case 'useradd':
    case 'userdel':
    case 'usermod':
    case 'passwd-user': {
      const r = await runAdmin(env, action, body, { identity, sessionId: adm.sessionId, sudo: false });
      if (r.audit) await audit(r.audit, r.ok);
      return r.res;
    }

    default:
      return apiError(400, 'action');
  }
}
