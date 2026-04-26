# Deployment — IPFS + ENS

ArcSwap targets **immutable, decentralized hosting** for production. This means:

- Build artifacts pinned to **IPFS** (content-addressed, can't be silently swapped)
- DNS-equivalent via **ENS** (`arcswap.eth` → resolves to latest IPFS CID)
- Fallback HTTPS gateway for users without an IPFS-aware browser

This document is the runbook. Run it for every release.

---

## Why IPFS + ENS?

| Risk | Centralized host (Vercel/Netlify) | IPFS + ENS |
|---|---|---|
| DNS hijack | Attacker controls your domain → serves malicious build | ENS is on-chain → can only be changed by your wallet/multi-sig |
| Build pipeline compromise | Attacker pushes bad commit → live in seconds | Each release pinned to a CID; users can verify hash |
| Host takedown | Vercel/Netlify can suspend account | IPFS is censorship-resistant; pinned by multiple providers |
| Frontend supply-chain attack | Hard to detect | Hash mismatch = browser refuses load |

**Standard in DeFi**: Uniswap, 1inch, Aave, Curve all deploy via IPFS + ENS. We follow the same pattern.

---

## One-time setup

### Step 1 — Register ENS name

1. Go to https://app.ens.domains
2. Search for `arcswap.eth` (or your preferred name)
3. Register for **at least 1 year** (cost: ~$5-50 in ETH depending on length)
4. **Owner = your hardware wallet** (NOT a hot wallet)
5. After registration → ideally transfer ownership to a **multi-sig** (see `GOVERNANCE.md`)

### Step 2 — Set up IPFS pinning

You need at least **2 independent pinning providers** for redundancy:

| Provider | Free tier | Notes |
|---|---|---|
| **web3.storage** | 5 GB free | Backed by Filecoin, default choice |
| **Pinata** | 1 GB free | Industry standard |
| **Fleek** | Free with limits | All-in-one (IPFS + ENS + CI) |
| **Storj** | 25 GB free / month | S3-compatible IPFS gateway |

Get API tokens from at least 2 providers and store them securely (1Password / Bitwarden).

### Step 3 — Configure environment

Copy `.env.example` → `.env` and fill in:

```bash
WEB3_STORAGE_TOKEN=eyJhbGc...
PINATA_JWT=eyJhbGc...
ENS_NAME=arcswap.eth
ENS_RESOLVER=0x4976fb03C32e5B8cfe2b6cCB31c09Ba78EBaBa41  # ENS PublicResolver mainnet
DEPLOYER_PRIVATE_KEY=  # Empty — use hardware wallet via Frame/Rabby
```

`.env` is gitignored. Never commit it.

---

## Per-release deploy flow

### Step 1 — Build & verify locally

```bash
# 1. Make sure you're on the release branch
git status                        # working tree clean
git log -1 --oneline              # note commit SHA

# 2. Run security checks
./scripts/preflight-check.sh      # checks CSP, SRI, no secrets

# 3. Bundle the static site
mkdir -p dist
cp -r assets dist/
cp *.html dist/
cp -r .well-known dist/
cp _headers dist/                 # Cloudflare/Netlify will read this
```

### Step 2 — Pin to IPFS

```bash
./scripts/deploy-ipfs.sh ./dist
```

This will:
- Upload `dist/` to web3.storage AND Pinata in parallel
- Print the CID (Content Identifier)
- Verify the same CID returned from both providers (sanity check)
- Save CID to `releases/RELEASE-YYYY-MM-DD.json` for audit trail

### Step 3 — Update ENS contenthash

Open the ENS app → `arcswap.eth` → Records → Content Hash:

```
ipfs://bafybeig...   ← the CID from step 2
```

If owner is a multi-sig:
1. Propose tx via Safe UI
2. Sign with N of M signers
3. Execute

This step is **on-chain** and costs gas (~$2-5 on mainnet). It is the only step that requires the production key.

### Step 4 — Verify

```bash
# Browser-friendly gateway should serve the new build
curl -I https://arcswap.eth.limo

# Direct IPFS access (Brave / Opera / IPFS Companion)
ipfs://bafybeig...

# ENS resolution
cast call $ENS_PUBLIC_RESOLVER "contenthash(bytes32)" $(namehash arcswap.eth)
```

### Step 5 — Update release notes

Edit `releases/RELEASE-YYYY-MM-DD.json`:

```json
{
  "version": "9.1.11",
  "released": "2026-04-25T13:24:00Z",
  "commit": "abc1234...",
  "ipfs_cid": "bafybeig...",
  "ens_tx": "0xabc...",
  "signed_by": ["alice.eth", "bob.eth", "carol.eth"],
  "changes": "Brief summary"
}
```

Commit + push. This file is the **public audit trail**.

---

## Fallback HTTPS gateway

For users without IPFS-aware browsers, point a CNAME:

```
arcswap.net  CNAME  arcswap.eth.limo
```

`eth.limo` is a free public gateway that resolves ENS → IPFS → HTTPS. Alternatives: `eth.link`, `dweb.link`, or self-hosted.

---

## Rollback

If a deploy is broken:

1. **Revert ENS contenthash** to the previous known-good CID (IPFS pins are immutable, so the old CID still works)
2. Multi-sig signers approve the rollback tx
3. Update `releases/` with rollback note

This is faster and safer than a Web2 rollback because the previous build is always still pinned.

---

## Checklist per release

- [ ] Working tree clean, all tests pass
- [ ] `./scripts/preflight-check.sh` passes
- [ ] `./scripts/deploy-ipfs.sh dist/` succeeds
- [ ] CID identical from both pinning providers
- [ ] CID locally fetchable: `curl https://w3s.link/ipfs/<CID>/index.html`
- [ ] Multi-sig tx for ENS update created + signed
- [ ] Tx executed, block confirmed
- [ ] `arcswap.eth.limo` serves new build
- [ ] `releases/RELEASE-*.json` committed
- [ ] Status page updated
- [ ] Discord / Twitter announcement

---

_For questions: ops@arcswap.net_
