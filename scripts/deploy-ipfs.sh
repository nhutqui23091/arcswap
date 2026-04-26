#!/usr/bin/env bash
# deploy-ipfs.sh — pin a static build directory to IPFS via web3.storage + Pinata
#
# Usage:   ./scripts/deploy-ipfs.sh ./dist
# Requires: w3 (npm i -g @web3-storage/w3cli), curl, jq
# Env:     WEB3_STORAGE_TOKEN, PINATA_JWT  (load via .env)

set -euo pipefail

# ─── Config ──────────────────────────────────────────────────────────────────
DIST_DIR="${1:-./dist}"
RELEASES_DIR="./releases"
DATE_TAG=$(date -u +"%Y-%m-%d")
RELEASE_FILE="${RELEASES_DIR}/RELEASE-${DATE_TAG}.json"

# Load .env if present
if [[ -f .env ]]; then
  # shellcheck disable=SC1091
  set -a; source .env; set +a
fi

# ─── Sanity checks ───────────────────────────────────────────────────────────
[[ -d "$DIST_DIR" ]] || { echo "❌ $DIST_DIR not found. Run build first."; exit 1; }
[[ -n "${WEB3_STORAGE_TOKEN:-}" ]] || { echo "❌ WEB3_STORAGE_TOKEN missing in .env"; exit 1; }
[[ -n "${PINATA_JWT:-}" ]] || { echo "❌ PINATA_JWT missing in .env"; exit 1; }
command -v w3 >/dev/null || { echo "❌ w3 CLI missing. Install: npm i -g @web3-storage/w3cli"; exit 1; }
command -v jq >/dev/null || { echo "❌ jq missing. Install via your package manager."; exit 1; }

mkdir -p "$RELEASES_DIR"

echo "📦 Deploying $DIST_DIR …"
COMMIT=$(git rev-parse HEAD 2>/dev/null || echo "unknown")
SIZE=$(du -sh "$DIST_DIR" | cut -f1)
echo "   Commit: $COMMIT"
echo "   Size:   $SIZE"
echo

# ─── Pin to web3.storage ─────────────────────────────────────────────────────
echo "🌐 [1/2] Uploading to web3.storage …"
W3_OUT=$(w3 up "$DIST_DIR" --json 2>&1)
W3_CID=$(echo "$W3_OUT" | jq -r '.root."/"' || echo "$W3_OUT" | grep -oE 'baf[a-z0-9]{50,}' | head -1)
[[ -n "$W3_CID" && "$W3_CID" != "null" ]] || { echo "❌ web3.storage upload failed"; echo "$W3_OUT"; exit 1; }
echo "   ✓ web3.storage CID: $W3_CID"
echo

# ─── Pin to Pinata ───────────────────────────────────────────────────────────
echo "📌 [2/2] Pinning to Pinata …"
PIN_OUT=$(curl -sS -X POST https://api.pinata.cloud/pinning/pinFileToIPFS \
  -H "Authorization: Bearer ${PINATA_JWT}" \
  -F "file=@${DIST_DIR}" \
  -F "pinataOptions={\"cidVersion\":1}")
PIN_CID=$(echo "$PIN_OUT" | jq -r '.IpfsHash')
[[ -n "$PIN_CID" && "$PIN_CID" != "null" ]] || { echo "❌ Pinata upload failed"; echo "$PIN_OUT"; exit 1; }
echo "   ✓ Pinata CID:        $PIN_CID"
echo

# ─── Verify CIDs match ───────────────────────────────────────────────────────
if [[ "$W3_CID" != "$PIN_CID" ]]; then
  echo "⚠️  WARNING: CID mismatch between providers!"
  echo "   web3.storage: $W3_CID"
  echo "   Pinata:        $PIN_CID"
  echo "   This usually means a non-deterministic build (timestamps, random IDs)."
  echo "   Use w3 CID as the canonical reference."
fi

# ─── Write release manifest ──────────────────────────────────────────────────
cat > "$RELEASE_FILE" <<EOF
{
  "version": "$(grep -oP "(?<=version: ')[^']+" assets/arc-core.js | head -1 || echo "unknown")",
  "released": "$(date -u +"%Y-%m-%dT%H:%M:%SZ")",
  "commit": "$COMMIT",
  "size": "$SIZE",
  "ipfs_cid": "$W3_CID",
  "providers": {
    "web3_storage": "$W3_CID",
    "pinata": "$PIN_CID"
  },
  "ens_tx": null,
  "signed_by": [],
  "verified": false
}
EOF

echo "📝 Release manifest written: $RELEASE_FILE"
echo
echo "🔗 Verify the build:"
echo "   https://w3s.link/ipfs/$W3_CID/"
echo "   https://gateway.pinata.cloud/ipfs/$PIN_CID/"
echo
echo "🧬 Next step: update ENS contenthash to ipfs://$W3_CID via your multi-sig."
echo "   See docs/DEPLOYMENT.md step 3."
