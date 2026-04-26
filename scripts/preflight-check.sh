#!/usr/bin/env bash
# preflight-check.sh — quick pre-deploy security & integrity audit
#
# Runs against the working tree before bundling.

set -euo pipefail

PASS=0
FAIL=0

ok()   { echo "  ✓ $1"; PASS=$((PASS+1)); }
fail() { echo "  ✗ $1"; FAIL=$((FAIL+1)); }

echo "🔍 ArcSwap pre-flight check"
echo

# ─── 1. CSP meta tag in every HTML ───────────────────────────────────────────
echo "[1/6] Content-Security-Policy in every HTML…"
MISSING=$(grep -L "Content-Security-Policy" *.html 2>/dev/null || true)
if [[ -z "$MISSING" ]]; then
  ok "CSP present in all HTML files"
else
  fail "CSP missing in: $MISSING"
fi

# ─── 2. SRI on all jsdelivr scripts ──────────────────────────────────────────
# Only flag actual <script src="https://cdn.jsdelivr.net/..."> tags.
# Skip CSP meta tags (which mention jsdelivr as an allowed origin, not as a script).
echo "[2/6] SRI integrity on jsdelivr scripts…"
NO_SRI=""
for f in *.html; do
  # Pull every <script ...> tag (may span lines) that loads from jsdelivr,
  # then check whether it also contains integrity=
  if awk '
    BEGIN{ RS="<script"; FS="</script>" }
    NR>1 && /src="https?:\/\/cdn\.jsdelivr\.net/ && !/integrity=/ { exit 1 }
  ' "$f"; then
    :  # ok
  else
    NO_SRI="$NO_SRI $f"
  fi
done
if [[ -z "$NO_SRI" ]]; then
  ok "All jsdelivr <script> tags have SRI"
else
  fail "Missing SRI in:$NO_SRI"
fi

# ─── 3. target=_blank without rel=noopener ───────────────────────────────────
echo "[3/6] target=\"_blank\" with rel=\"noopener\"…"
BAD_TARGETS=$(grep -rE 'target="_blank"' *.html | grep -v 'rel=' || true)
if [[ -z "$BAD_TARGETS" ]]; then
  ok "All target=_blank have rel=noopener"
else
  fail "Missing rel=noopener:"
  echo "$BAD_TARGETS"
fi

# ─── 4. No hardcoded secrets ─────────────────────────────────────────────────
echo "[4/6] No hardcoded secrets…"
SECRETS=$(grep -rEi '(api[_-]?key|secret|bearer|authorization)\s*[:=]\s*["'\''][^"'\'']{8,}' \
  --include="*.html" --include="*.js" --include="*.json" \
  --exclude-dir=node_modules --exclude-dir=.git . 2>/dev/null || true)
if [[ -z "$SECRETS" ]]; then
  ok "No obvious secrets in tracked files"
else
  fail "Potential secrets found:"
  echo "$SECRETS"
fi

# ─── 5. .env not committed ───────────────────────────────────────────────────
echo "[5/6] .env not in git…"
if git ls-files --error-unmatch .env >/dev/null 2>&1; then
  fail ".env is tracked by git! Remove with: git rm --cached .env"
else
  ok ".env not tracked"
fi

# ─── 6. _headers / vercel.json present ───────────────────────────────────────
echo "[6/6] Host security headers configured…"
if [[ -f "_headers" || -f "vercel.json" || -f "netlify.toml" ]]; then
  ok "Host headers file present"
else
  fail "No _headers / vercel.json / netlify.toml found"
fi

# ─── Summary ─────────────────────────────────────────────────────────────────
echo
echo "════════════════════════════════════════"
echo " Passed: $PASS    Failed: $FAIL"
echo "════════════════════════════════════════"

if [[ $FAIL -gt 0 ]]; then
  echo "❌ Pre-flight FAILED — fix issues before deploying."
  exit 1
fi
echo "✅ Pre-flight passed. Ready to deploy."
