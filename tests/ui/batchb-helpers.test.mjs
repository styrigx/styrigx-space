/**
 * 批次 B #36 / #12 纯函数测试（node --test）。
 *
 * - mapFetchError：五分支错误文案（网络/解析/5xx/challenge/业务错返回 null）。
 * - formatDoorRemaining：毫秒 → 'm:ss'，<=0 时 '0:00'。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mapFetchError } from '../../assets/js/lib/map-fetch-error.js';
import { formatDoorRemaining } from '../../assets/js/apps/app-gate.js';

test('#36 mapFetchError：五分支', () => {
  const texts = { network: 'NET', parse: 'PARSE', server: 'SRV', challenge: 'CHAL' };
  assert.equal(mapFetchError({ kind: 'network' }, texts), 'NET');
  assert.equal(mapFetchError({ kind: 'parse' }, texts), 'PARSE');
  assert.equal(mapFetchError({ kind: 'http', status: 500 }, texts), 'SRV');
  assert.equal(mapFetchError({ kind: 'http', status: 503 }, texts), 'SRV');
  assert.equal(mapFetchError({ kind: 'challenge' }, texts), 'CHAL');
  assert.equal(mapFetchError({ kind: 'http', status: 429 }, texts), null, '业务错（4xx）返回 null，由调用方保持具体文案');
  assert.equal(mapFetchError({ kind: 'http', status: 400 }, texts), null);
  assert.equal(mapFetchError({ kind: 'unknown' }, texts), null);
});

test('#12 formatDoorRemaining：m:ss', () => {
  assert.equal(formatDoorRemaining(179000), '2:59');
  assert.equal(formatDoorRemaining(180000), '3:00');
  assert.equal(formatDoorRemaining(30000), '0:30');
  assert.equal(formatDoorRemaining(5000), '0:05');
  assert.equal(formatDoorRemaining(0), '0:00');
  assert.equal(formatDoorRemaining(-1000), '0:00');
  assert.equal(formatDoorRemaining(59999), '1:00', '向上取整到秒');
});
