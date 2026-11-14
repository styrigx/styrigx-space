/**
 * `/`、`/healthz`：健康检查（任意方法），styrigx-status 每分钟测 /healthz。
 */
import { text } from '../lib/http.js';

export function healthz() {
  return text('styrigx-proxy ok\n');
}
