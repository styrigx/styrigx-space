#!/usr/bin/env bash
# 本地按 CI 的分组跑一遍（.github/workflows/deploy.yml 的 unit / build / e2e-lock / e2e-sites / visual / lighthouse / passkey-e2e）。
# 出补丁前跑；某一组红了照样往下跑，最后一行汇总各组结果，红了退出码非 0。
#
# 用法：scripts/ci-local.sh [组 ...]
#   组：unit build e2e-lock e2e-sites visual lighthouse passkey；不写 = 除 lighthouse 外全部（lighthouse 要 Chrome，按需加）。
# 前提：Node 22（node:sqlite）、已 npm ci、hugo 在 PATH 上（版本见 .github/actions/setup-hugo）。
# 不碰 Cloudflare：passkey 组走本地模拟器（tests/web/e2e/preview-emulator.cjs），凭证每次现生成。
# 构建顺序和 CI 一致：build 组做主站生产构建 → 拼树；e2e-lock 用这份生产构建，gate 关的构建放最后；
# visual / lighthouse 各自再做测试构建（SGX_TEST_NO_LOCK=1 SGX_TEST_NO_WEATHER=1）；passkey 做普通构建。
set -uo pipefail
cd "$(dirname "$0")/.."
# 本机测试服务器一律直连：机器上设了 HTTP(S)_PROXY 时，Playwright 的 webServer 就绪检查会走代理拿到 404，干等到超时
export NO_PROXY="localhost,127.0.0.1,::1${NO_PROXY:+,$NO_PROXY}" no_proxy="localhost,127.0.0.1,::1${no_proxy:+,$no_proxy}"
# 本机测试服务器一律直连：机器上设了 HTTP(S)_PROXY 时，Playwright 的 webServer 就绪检查会走代理拿到 404，干等到超时
export NO_PROXY="localhost,127.0.0.1,::1${NO_PROXY:+,$NO_PROXY}" no_proxy="localhost,127.0.0.1,::1${no_proxy:+,$no_proxy}"

ALL=(unit build e2e-lock e2e-sites visual passkey)
if [ $# -gt 0 ]; then GROUPS_TO_RUN=("$@"); else GROUPS_TO_RUN=("${ALL[@]}"); fi

declare -A RESULT
ORDER=()
step() { # step <组> <说明> <命令...>
  local g="$1" what="$2"; shift 2
  echo; echo "── [$g] $what"
  if "$@"; then :; else RESULT[$g]=fail; echo "!! [$g] $what 失败"; fi
}
begin() { ORDER+=("$1"); RESULT[$1]=pass; }
want() { local g; for g in "${GROUPS_TO_RUN[@]}"; do [ "$g" = "$1" ] && return 0; done; return 1; }

# ── 环境自检：缺什么先说清楚，不让后面几十个用例一起莫名其妙地红
preflight() {
  local bad=0
  node -e "require('node:sqlite')" 2>/dev/null || { echo "!! 没有 node:sqlite（需要 Node 22）"; bad=1; }
  [ -d node_modules ] || { echo "!! 没有 node_modules，先 npm ci"; bad=1; }
  if want build || want e2e-lock || want visual || want lighthouse || want passkey; then
    command -v hugo >/dev/null || { echo "!! hugo 不在 PATH 上"; bad=1; }
  fi
  if want e2e-lock || want e2e-sites || want visual || want passkey; then
    # 浏览器装了但系统库缺（例如 libatk-1.0.so.0）时，launch 会以 127 退出：真起一次 headless shell 才算数
    if ! node -e "require('@playwright/test').chromium.launch().then(b=>b.close()).catch(e=>{console.error(String(e).split('\n')[0]);process.exit(1)})"; then
      echo "!! Playwright Chromium 起不来：npx playwright install --only-shell chromium；缺系统库再 sudo npx playwright install-deps chromium"
      bad=1
    fi
  fi
  return $bad
}
if ! preflight; then echo; echo "环境不齐，未开始。"; exit 2; fi

css() { node scripts/build-css.cjs --minify >/dev/null; }

if want unit; then
  begin unit
  step unit "build-css" css
  step unit "单测（workers + ui）" bash -c 'node --test tests/workers/auth-gateway/*.test.mjs tests/workers/account/*.test.mjs tests/workers/share/*.test.mjs tests/workers/chat/*.test.mjs tests/workers/search-index/*.test.mjs tests/workers/ai/*.test.mjs tests/workers/status/*.test.mjs tests/workers/proxy-rules/*.test.mjs tests/web/ui/*.test.mjs 2>&1 | tee /tmp/ci-local-unit.log | grep -E "^# (tests|pass|fail|skipped)"; ! grep -qE "^# fail [1-9]" /tmp/ci-local-unit.log'
fi

if want build; then
  begin build
  step build "build-css" css
  for c in "gen-shell.mjs --check" "gen-palettes.mjs --check" "gen-ui-cookie-contract.mjs --check" "check-layers.mjs" "check-frontend.mjs"; do
    step build "$c" bash -c "node scripts/$c >/dev/null"
  done
  step build "主站生产构建" bash -c 'hugo --minify -s web/atlas >/dev/null'
  step build "gen-csp --check" bash -c 'node scripts/gen-csp.mjs --check >/dev/null'
  step build "子站构建" bash -c 'npm run --silent build:sites >/dev/null'
  step build "test:sites" bash -c 'npm run --silent test:sites 2>&1 | grep -E "^# (tests|pass|fail|skipped)"; exit ${PIPESTATUS[0]}'
  step build "拼树 + 拼树单测" bash -c 'node scripts/assemble.mjs >/dev/null && node --test tests/web/ui/assemble.test.mjs >/dev/null'
  step build "check-worker-routes" bash -c 'node scripts/check-worker-routes.mjs >/dev/null'
  step build "子站生成物同步" bash -c 'node scripts/curio/gen-seed-sql.mjs --check >/dev/null && node scripts/blog/gen-code-tokens.mjs --check >/dev/null && for s in blog curio daymark; do node "scripts/$s/sync-shell.mjs" --check >/dev/null || exit 1; done'
  step build "stylelint" npx stylelint --config tests/config/stylelintrc.json "web/atlas/assets/css/input.css"
fi

PW="npx playwright test --config=tests/config/playwright.config.js"
if want e2e-lock; then
  begin e2e-lock
  # 没跑 build 组就自己做一次生产构建
  if ! want build; then step e2e-lock "build-css + 主站生产构建" bash -c 'node scripts/build-css.cjs --minify >/dev/null && hugo --minify -s web/atlas >/dev/null'; fi
  step e2e-lock "lock" bash -c "SGX_TEST_SUITE=lock $PW --grep-invert 'baseline screenshot' --reporter=line"
  step e2e-lock "edge" bash -c "SGX_TEST_SUITE=edge $PW --reporter=line"
  step e2e-lock "lock baseline" bash -c "SGX_TEST_SUITE=lock $PW --grep 'baseline screenshot' --reporter=line"
  step e2e-lock "credential" bash -c "SGX_TEST_SUITE=credential $PW --reporter=line"
  step e2e-lock "lock-gate 关" bash -c "SGX_TEST_LOCK_GATE=0 hugo --minify -s web/atlas >/dev/null && SGX_TEST_SUITE=lock SGX_TEST_FLAGS=gate-off $PW lock-flags.spec.js --reporter=line"
fi

if want e2e-sites; then
  begin e2e-sites
  [ -d dist/site ] || { echo "!! 没有 dist/site：先跑 build 组"; RESULT[e2e-sites]=fail; }
  if [ "${RESULT[e2e-sites]}" = pass ]; then
    step e2e-sites "blog" bash -c 'env -u BLOG_BASE_URL npx playwright test --config=tests/blog/config/playwright.config.js --reporter=line'
    step e2e-sites "curio" npx playwright test --config=tests/curio/config/playwright.e2e.config.js --reporter=line
    step e2e-sites "daymark" npx playwright test --config=tests/daymark/config/playwright.e2e.config.js --reporter=line
  fi
fi

if want visual; then
  begin visual
  step visual "测试构建（锁屏禁用）" bash -c 'node scripts/build-css.cjs --minify >/dev/null && SGX_TEST_NO_LOCK=1 SGX_TEST_NO_WEATHER=1 hugo --minify -s web/atlas >/dev/null'
  step visual "visual 默认组" bash -c "$PW --reporter=line"
fi

if want lighthouse; then
  begin lighthouse
  step lighthouse "测试构建（锁屏禁用）" bash -c 'node scripts/build-css.cjs --minify >/dev/null && SGX_TEST_NO_LOCK=1 SGX_TEST_NO_WEATHER=1 hugo --minify -s web/atlas >/dev/null'
  step lighthouse "Lighthouse CI" bash -c "find web/atlas/public -type f \( -name '*.html' -o -name '*.css' -o -name '*.js' \) -exec gzip -kf -9 {} \; && npx lhci autorun --config=tests/config/lighthouserc.json"
fi

if want passkey; then
  begin passkey
  step passkey "build-css + 构建" bash -c 'node scripts/build-css.cjs --minify >/dev/null && hugo --minify -s web/atlas >/dev/null'
  SPACE_KEY="$(openssl rand -hex 32)"; ROOT_KEY="$(openssl rand -hex 32)"; PEPPER="$(openssl rand -hex 32)"
  LOG="$(mktemp)"
  node tests/web/e2e/preview-emulator.cjs --port 8788 --space-key "$SPACE_KEY" --account-root-key "$ROOT_KEY" --pepper "$PEPPER" >"$LOG" 2>&1 &
  EMU=$!
  trap 'kill $EMU 2>/dev/null' EXIT
  ready=0
  for _ in $(seq 60); do
    curl -fsS -o /dev/null http://127.0.0.1:8788/__kv/stats 2>/dev/null && { ready=1; break; }
    kill -0 $EMU 2>/dev/null || break
    sleep 1
  done
  if [ $ready = 1 ]; then
    step passkey "passkey（本地模拟器）" env SGX_TEST_SUITE=passkey SGX_TEST_BASE=http://localhost:8788 \
      SGX_TEST_SPACE_KEY="$SPACE_KEY" SGX_TEST_ACCOUNT_ROOT_KEY="$ROOT_KEY" \
      SGX_TEST_CF_API=http://127.0.0.1:8788/client/v4 SGX_TEST_CF_TOKEN=x SGX_TEST_CF_ACCOUNT=x SGX_TEST_PREVIEW_D1_ID=local CI=1 \
      npx playwright test --config=tests/config/playwright.config.js --reporter=line
  else
    cat "$LOG"; echo "!! 预览模拟器没起来"; RESULT[passkey]=fail
  fi
  kill $EMU 2>/dev/null; trap - EXIT
fi

echo
line="ci-local:"; rc=0
for g in "${ORDER[@]}"; do line+=" $g=${RESULT[$g]}"; [ "${RESULT[$g]}" = pass ] || rc=1; done
echo "$line"
exit $rc
