/**
 * @fileoverview 鉴权 Worker 的路由表：/api/<名字> → functions/api/<名字>.js。
 *
 * 代替 Pages 的「按文件路由」。functions/api/ 新增或删除文件时这里要同步，
 * tests/kernel/auth-worker.test.mjs 会检查两边一致，漏了 CI 会红。
 */
import * as appToken from '../functions/api/app-token.js';
import * as avatar from '../functions/api/avatar.js';
import * as books from '../functions/api/books.js';
import * as geo from '../functions/api/geo.js';
import * as layerStatus from '../functions/api/layer-status.js';
import * as lock from '../functions/api/lock.js';
import * as lockAllDevices from '../functions/api/lock-all-devices.js';
import * as lockConfig from '../functions/api/lock-config.js';
import * as lockStatus from '../functions/api/lock-status.js';
import * as lockreset from '../functions/api/lockreset.js';
import * as ownerPasskey from '../functions/api/owner-passkey.js';
import * as ownerPassword from '../functions/api/owner-password.js';
import * as ownerStatus from '../functions/api/owner-status.js';
import * as rootAudit from '../functions/api/root-audit.js';
import * as rootAuth from '../functions/api/root-auth.js';
import * as rootSession from '../functions/api/root-session.js';
import * as sessionCheck from '../functions/api/session-check.js';
import * as sessionEpoch from '../functions/api/session-epoch.js';
import * as stepup from '../functions/api/stepup.js';
import * as verify from '../functions/api/verify.js';
import * as wellbeing from '../functions/api/wellbeing.js';

/** @type {Map<string, Record<string, Function>>} */
export const API_ROUTES = new Map([
  ['/api/app-token', appToken],
  ['/api/avatar', avatar],
  ['/api/books', books],
  ['/api/geo', geo],
  ['/api/layer-status', layerStatus],
  ['/api/lock', lock],
  ['/api/lock-all-devices', lockAllDevices],
  ['/api/lock-config', lockConfig],
  ['/api/lock-status', lockStatus],
  ['/api/lockreset', lockreset],
  ['/api/owner-passkey', ownerPasskey],
  ['/api/owner-password', ownerPassword],
  ['/api/owner-status', ownerStatus],
  ['/api/root-audit', rootAudit],
  ['/api/root-auth', rootAuth],
  ['/api/root-session', rootSession],
  ['/api/session-check', sessionCheck],
  ['/api/session-epoch', sessionEpoch],
  ['/api/stepup', stepup],
  ['/api/verify', verify],
  ['/api/wellbeing', wellbeing],
]);
