/**
 * @fileoverview 鉴权 Worker 的路由表：/api/<名字> → functions/api/<名字>.js。
 *
 * 代替 Pages 的「按文件路由」。functions/api/ 新增或删除文件时这里要同步，
 * tests/kernel/auth-worker.test.mjs 会检查两边一致，漏了 CI 会红。
 * 头像（/api/avatar、/avatar/*）、云同步（/api/prefs）、数字健康（/api/wellbeing）2026-10-24 搬到账号 Worker
 * styrigx-account（workers/account，有自己的路由），不在这里。
 */
import * as account from '../functions/api/account.js';
import * as chat from '../functions/api/chat.js';
import * as geo from '../functions/api/geo.js';
import * as layerStatus from '../functions/api/layer-status.js';
import * as lock from '../functions/api/lock.js';
import * as lockAllDevices from '../functions/api/lock-all-devices.js';
import * as lockConfig from '../functions/api/lock-config.js';
import * as lockDoor from '../functions/api/lock-door.js';
import * as lockStatus from '../functions/api/lock-status.js';
import * as lockTemp from '../functions/api/lock-temp.js';
import * as lockTempUnlock from '../functions/api/lock-temp-unlock.js';
import * as lockreset from '../functions/api/lockreset.js';
import * as ownerPasskey from '../functions/api/owner-passkey.js';
import * as ownerPassword from '../functions/api/owner-password.js';
import * as rootAudit from '../functions/api/root-audit.js';
import * as rootAuth from '../functions/api/root-auth.js';
import * as rootSession from '../functions/api/root-session.js';
import * as search from '../functions/api/search.js';
import * as sessionCheck from '../functions/api/session-check.js';
import * as sessionEpoch from '../functions/api/session-epoch.js';
import * as status from '../functions/api/status.js';

/** @type {Map<string, Record<string, Function>>} */
export const API_ROUTES = new Map([
  ['/api/account', account],
  ['/api/chat', chat],
  ['/api/geo', geo],
  ['/api/layer-status', layerStatus],
  ['/api/lock', lock],
  ['/api/lock-all-devices', lockAllDevices],
  ['/api/lock-config', lockConfig],
  ['/api/lock-door', lockDoor],
  ['/api/lock-status', lockStatus],
  ['/api/lock-temp', lockTemp],
  ['/api/lock-temp-unlock', lockTempUnlock],
  ['/api/lockreset', lockreset],
  ['/api/owner-passkey', ownerPasskey],
  ['/api/owner-password', ownerPassword],
  ['/api/root-audit', rootAudit],
  ['/api/root-auth', rootAuth],
  ['/api/root-session', rootSession],
  ['/api/search', search],
  ['/api/session-check', sessionCheck],
  ['/api/session-epoch', sessionEpoch],
  ['/api/status', status],
]);
