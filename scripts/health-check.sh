#!/usr/bin/env bash
# health-check.sh — sanity probe for ArcSwap production endpoints
#
# Run from cron / Better Stack / GitHub Actions every 5 min.
# Exit 0 = healthy, exit 1 = degraded (page on-call).

set -uo pipefail

ARC_RPC="${ARC_RPC:-https://rpc.testnet.arc.network}"
IRIS_BASE="${IRIS_BASE:-https://iris-api-sandbox.circle.com/v2}"
APP_URL="${APP_URL:-https://arcswap.net}"
APP_BACKUP_URL="${APP_BACKUP_URL:-https://arcswap.eth.limo}"
USYC_TELLER="${USYC_TELLER:-0x9fdF14c5B14173D74C08Af27AebFf39240dC105A}"

# Webhook for Discord/Slack alerting (optional — set in env)
ALERT_WEBHOOK="${ALERT_WEBHOOK:-}"

# User-Agent cho curl — giống browser thật để bypass Cloudflare Bot Fight Mode
# khi chạy từ datacenter IP (vd GitHub Actions runner).
UA="Mozilla/5.0 (compatible; ArcSwap-HealthCheck/1.0; +https://arcswap.net)"

# Helper: curl với UA + timeout chuẩn
cf_curl() { curl -sA "$UA" --max-time 10 "$@"; }

FAILED=0
CHECKS=()

# ─── Helper: record check result ─────────────────────────────────────────────
check() {
  local name="$1"
  local status="$2"
  local detail="${3:-}"
  CHECKS+=("$status $name${detail:+ — $detail}")
  if [[ "$status" == "❌" ]]; then
    FAILED=$((FAILED+1))
  fi
}

# ─── 1. Frontend reachable ───────────────────────────────────────────────────
HTTP_CODE=$(cf_curl -o /dev/null -w "%{http_code}" "$APP_URL" || echo "000")
if [[ "$HTTP_CODE" == "200" ]]; then
  check "Frontend ($APP_URL)" "✓" "200 OK"
else
  check "Frontend ($APP_URL)" "❌" "HTTP $HTTP_CODE"
fi

# Backup URL (CNAME via eth.limo or paid host)
# Skip check if APP_BACKUP_URL is not set or points to eth.limo and ENS not yet
# configured (avoids false alarm during testnet stage).
if [[ -n "$APP_BACKUP_URL" && "$APP_BACKUP_URL" != *"eth.limo"* ]]; then
  HTTP_CODE_BACKUP=$(cf_curl -o /dev/null -w "%{http_code}" "$APP_BACKUP_URL" || echo "000")
  if [[ "$HTTP_CODE_BACKUP" == "200" ]]; then
    check "Frontend backup ($APP_BACKUP_URL)" "✓" "200 OK"
  else
    check "Frontend backup ($APP_BACKUP_URL)" "❌" "HTTP $HTTP_CODE_BACKUP"
  fi
fi

# ─── 2. Critical security headers present ────────────────────────────────────
HEADERS=$(cf_curl -I "$APP_URL" 2>/dev/null || echo "")
if echo "$HEADERS" | grep -qi "content-security-policy"; then
  check "CSP header" "✓"
else
  check "CSP header" "❌" "missing"
fi
if echo "$HEADERS" | grep -qi "strict-transport-security"; then
  check "HSTS header" "✓"
else
  check "HSTS header" "❌" "missing"
fi

# ─── 3. Arc RPC alive + chain advancing ──────────────────────────────────────
RPC_RES=$(curl -s --max-time 10 -X POST "$ARC_RPC" \
  -H "content-type: application/json" \
  -d '{"jsonrpc":"2.0","method":"eth_blockNumber","id":1}' 2>/dev/null || echo "")
BLOCK_HEX=$(echo "$RPC_RES" | grep -oE '"result":"0x[a-f0-9]+"' | grep -oE '0x[a-f0-9]+' | head -1)
if [[ -n "$BLOCK_HEX" ]]; then
  BLOCK_NUM=$((BLOCK_HEX))
  check "Arc RPC" "✓" "block $BLOCK_NUM"

  # Compare with previous block (5 min ago) — chain must advance
  PREV_FILE="/tmp/arcswap-last-block"
  if [[ -f "$PREV_FILE" ]]; then
    PREV_BLOCK=$(cat "$PREV_FILE")
    if [[ "$BLOCK_NUM" -le "$PREV_BLOCK" ]]; then
      check "Chain advancing" "❌" "stuck at $BLOCK_NUM (was $PREV_BLOCK)"
    else
      check "Chain advancing" "✓" "+$((BLOCK_NUM - PREV_BLOCK)) blocks"
    fi
  fi
  echo "$BLOCK_NUM" > "$PREV_FILE"
else
  check "Arc RPC" "❌" "no response"
fi

# ─── 4. USYC Teller reachable (read-only call) ───────────────────────────────
# Calls totalAssets() — selector 0x01e1d114
TELLER_RES=$(curl -s --max-time 10 -X POST "$ARC_RPC" \
  -H "content-type: application/json" \
  -d "{\"jsonrpc\":\"2.0\",\"method\":\"eth_call\",\"params\":[{\"to\":\"$USYC_TELLER\",\"data\":\"0x01e1d114\"},\"latest\"],\"id\":1}" \
  2>/dev/null || echo "")
if echo "$TELLER_RES" | grep -q '"result":"0x'; then
  check "USYC Teller" "✓"
else
  check "USYC Teller" "❌" "eth_call failed"
fi

# ─── 5. IRIS (CCTP attestation API) reachable ────────────────────────────────
IRIS_CODE=$(curl -s -o /dev/null -w "%{http_code}" --max-time 10 "$IRIS_BASE/fastBurnAllowance" || echo "000")
if [[ "$IRIS_CODE" == "200" || "$IRIS_CODE" == "404" ]]; then
  # 404 also OK — endpoint reachable, just no allowance set
  check "Circle IRIS" "✓" "HTTP $IRIS_CODE"
else
  check "Circle IRIS" "❌" "HTTP $IRIS_CODE"
fi

# ─── 6. Build hash matches latest pinned release ─────────────────────────────
# Compares served arc-core.js against the version string in latest release manifest
LATEST_RELEASE=$(ls -t releases/RELEASE-*.json 2>/dev/null | head -1 || echo "")
if [[ -n "$LATEST_RELEASE" ]]; then
  EXPECTED_VER=$(grep -oP '"version":\s*"\K[^"]+' "$LATEST_RELEASE")
  SERVED_VER=$(curl -s --max-time 10 "$APP_URL/assets/arc-core.js" | grep -oP "version: '\K[^']+" | head -1 || echo "unknown")
  if [[ "$EXPECTED_VER" == "$SERVED_VER" ]]; then
    check "Build version" "✓" "$SERVED_VER"
  else
    check "Build version" "❌" "served $SERVED_VER, expected $EXPECTED_VER"
  fi
fi

# ─── Print report ────────────────────────────────────────────────────────────
echo "ArcSwap health — $(date -u +"%Y-%m-%d %H:%M:%S UTC")"
printf '  %s\n' "${CHECKS[@]}"
echo

if [[ $FAILED -gt 0 ]]; then
  REPORT=$(printf '%s\n' "${CHECKS[@]}")
  echo "❌ $FAILED check(s) failed"

  # Notify if webhook configured
  if [[ -n "$ALERT_WEBHOOK" ]]; then
    curl -s -X POST "$ALERT_WEBHOOK" \
      -H "content-type: application/json" \
      -d "$(jq -n --arg c "🚨 ArcSwap health: $FAILED check(s) failed\n\n$REPORT" '{content: $c}')" \
      >/dev/null
  fi
  exit 1
fi

echo "✅ All systems nominal"
exit 0
