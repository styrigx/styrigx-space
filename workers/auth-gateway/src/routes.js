/**
 * @fileoverview 鉴权 Worker 的路由表：/api/<名字> → functions/api/<名字>.js。
 *
 * 代替 Pages 的「按文件路由」。functions/api/ 新增或删除文件时这里要同步，
 * tests/workers/auth-gateway/auth-worker.test.mjs 会检查两边一致，漏了 CI 会红。
 * 账号（/api/account、/api/prefs*、/api/avatar*、/api/wellbeing*、/avatar/*）不在这里：它们在转发表 src/forwarding.js，
 * 网关验完门后转给账号 Worker styrigx-account（账号拆分 PR3）。/api/layer-status 已删（前端无调用方）。
 */
import * as chat from '../functions/api/chat.js';
import * as geo from '../functions/api/geo.js';
import * as lockAllDevices from '../functions/api/lock-all-devices.js';
import * as lockCredentials from '../functions/api/lock-credentials.js';
import * as lockEntry from '../functions/api/lock-entry.js';
import * as lockNow from '../functions/api/lock-now.js';
import * as lockPasskey from '../functions/api/lock-passkey.js';
import * as lockPassword from '../functions/api/lock-password.js';
import * as lockReauth from '../functions/api/lock-reauth.js';
import * as lockReset from '../functions/api/lock-reset.js';
import * as lockSessionCheck from '../functions/api/lock-session-check.js';
import * as lockTempkey from '../functions/api/lock-tempkey.js';
import * as lockTempkeyUnlock from '../functions/api/lock-tempkey-unlock.js';
import * as rootAudit from '../functions/api/root-audit.js';
import * as rootAuth from '../functions/api/root-auth.js';
import * as search from '../functions/api/search.js';
import * as status from '../functions/api/status.js';

/** @type {Map<string, Record<string, Function>>} */
export const API_ROUTES = new Map([
  ['/api/chat', chat],
  ['/api/geo', geo],
  ['/api/lock-all-devices', lockAllDevices],
  ['/api/lock-credentials', lockCredentials],
  ['/api/lock-entry', lockEntry],
  ['/api/lock-now', lockNow],
  ['/api/lock-passkey', lockPasskey],
  ['/api/lock-password', lockPassword],
  ['/api/lock-reauth', lockReauth],
  ['/api/lock-reset', lockReset],
  ['/api/lock-session-check', lockSessionCheck],
  ['/api/lock-tempkey', lockTempkey],
  ['/api/lock-tempkey-unlock', lockTempkeyUnlock],
  ['/api/root-audit', rootAudit],
  ['/api/root-auth', rootAuth],
  ['/api/search', search],
  ['/api/status', status],
]);
