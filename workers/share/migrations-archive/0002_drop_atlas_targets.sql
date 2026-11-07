-- 旧图志域名 atlas.styrigx.com 下线（2026-11，Gray 批准「删 清干净」）：短链目标白名单只剩 styrigx.com（src/lib/links.js TARGET_HOSTS），
-- 指向 atlas.styrigx.com 的存量短链点开时已经只走失败响应，这里把它们删掉，列表里也不再出现。
-- 带会话的短链在网关还有一把短链钥匙（不进临时钥匙列表）：短链行删了，就没有入口能再用这把钥匙换会话，钥匙到期后自然失效；
--   已经换出去的会话按各自时长（≤ 7 天）到期，不在这里作废（要立刻作废，部署前在短链列表里先点作废）。
-- 有意的数据删除；部署时 deploy.yml 的 deploy-share-worker 先 wrangler d1 migrations apply 再部署。
DELETE FROM share_link WHERE target LIKE 'https://atlas.styrigx.com%';
