# ArcSwap

> The Yield Terminal for Stablecoins on **Arc Testnet**.

USYC vault · stablecoin swap · CCTP bridge · liquidity pools — one venue, one balance.

🌐 Live at **[arcswap.net](https://arcswap.net)** · 🐦 [@arc_swap](https://x.com/arc_swap) · 💬 [Discord](https://discord.gg/7XUPdWWrGk)

---

## What is this?

ArcSwap is a **non-custodial frontend** that brings four stablecoin primitives together
on the [Arc Layer 1](https://arc.network) blockchain:

| Feature | What it does | Underlying |
|---|---|---|
| **USYC Vault** | Earn ~4.85% APY on idle USDC via tokenized U.S. Treasury yield | [Hashnote USYC](https://www.hashnote.com) |
| **Swap** | Convert between USDC, EURC, USYC inside Arc | Uniswap V2 (deployed by Arc Foundation) |
| **Bridge** | Move USDC across chains (Arc ↔ Ethereum ↔ Base ↔ ...) | [Circle CCTP V2](https://www.circle.com/cross-chain-transfer-protocol) |
| **Pools** | Provide liquidity, earn 0.25% per trade | Uniswap V2 LP |

You always retain custody. ArcSwap never holds funds and has no backend that can pause your access.

---

## Tech stack

- **Pure HTML + CSS + vanilla JS** — no framework, no build step, no node_modules in production
- **ethers.js v6** — only external runtime dependency (loaded via SRI-pinned CDN)
- **Cloudflare Pages** — hosting + CDN + DDoS protection (free tier)
- **Optional: IPFS + ENS** — decentralized backup (see `docs/DEPLOYMENT.md`)

The entire site is ~9 HTML files + a few KB of shared assets. First paint < 1s on 4G.

---

## Local development

```bash
# Clone
git clone https://github.com/<your-username>/arc-swap-v9.git
cd arc-swap-v9

# Serve locally — any static server works. Examples:
python3 -m http.server 8080            # Python
npx serve .                            # Node
php -S localhost:8080                  # PHP
```

Open `http://localhost:8080` in a browser with MetaMask/Rabby installed.
You'll need testnet USDC from [faucet.circle.com](https://faucet.circle.com) on Arc Testnet.

No build step, no environment setup, no API keys needed for local dev.

---

## Deployment

**Primary path** — Cloudflare Pages (free, fast, secure):
→ See [`docs/DEPLOY_CLOUDFLARE.md`](docs/DEPLOY_CLOUDFLARE.md)

**Optional path** — IPFS + ENS (immutable, decentralized):
→ See [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md)

Before any deploy, run the pre-flight check:

```bash
bash scripts/preflight-check.sh
```

This verifies CSP, SRI, secrets hygiene, redirects, and host headers (6 checks).

---

## Project structure

```
arc-swap-v9/
├── index.html              ← Homepage
├── vault.html              ← USYC Vault (/vault)
├── trade.html              ← Swap + CCTP Bridge (/trade)
├── pool.html               ← Liquidity Pools (/pool)
├── point.html              ← Activity points (/point)
├── docs.html               ← Documentation (/docs)
├── blog.html               ← Blog (/blog)
├── token.html, deploy.html ← Misc utility pages
│
├── assets/
│   ├── arc-core.js         ← Shared on-chain helpers (RPC, ABIs, addresses)
│   └── social/             ← X avatar + cover SVGs
│
├── _headers                ← Cloudflare Pages security headers
├── _redirects              ← Cloudflare Pages clean URLs (/docs → /docs.html)
│
├── docs/
│   ├── DEPLOY_CLOUDFLARE.md  ← Primary deploy runbook
│   ├── DEPLOYMENT.md         ← Optional IPFS + ENS deploy
│   ├── GOVERNANCE.md         ← Multi-sig policy
│   └── INCIDENT_RESPONSE.md  ← What to do when things break
│
├── scripts/
│   ├── preflight-check.sh    ← Pre-deploy security audit
│   ├── health-check.sh       ← Production endpoint probe
│   └── deploy-ipfs.sh        ← Pin to web3.storage + Pinata
│
├── .well-known/security.txt  ← RFC 9116 vuln disclosure metadata
├── SECURITY.md               ← Vulnerability disclosure policy + bounty
├── SECURITY_CHECKLIST.md     ← Master security checklist
└── .env.example              ← Environment variables template
```

---

## Security

We take security seriously. Highlights:

- ✅ Content-Security-Policy on every page
- ✅ Subresource Integrity on every CDN script
- ✅ Strict referrer + permissions policies via `_headers`
- ✅ No secrets in the repo (enforced by `preflight-check.sh`)
- ✅ Multi-sig governance for any privileged action (see `docs/GOVERNANCE.md`)

**Found a vulnerability?** See [`SECURITY.md`](SECURITY.md). Bounties from $100 to $50,000.
Contact: `security@arcswap.net` (PGP key in `SECURITY.md`).

---

## Roadmap

| When | What |
|---|---|
| **Q2 2026** | USYC Vault polish — entitlements UX, position history, redemption queue |
| **Q3 2026** | Circle Gateway integration via Unified Balance Kit — multichain USDC deposits |
| **Q4 2026** | StableFX — RFQ-driven USDC ⇄ EURC PvP settlement via Arc FxEscrow |
| **2027** | Multi-vault yield products + B2B Memo references + **mainnet** |

See live roadmap on the [homepage](https://arcswap.net/#roadmap).

---

## Disclaimer

ArcSwap is **testnet-only** software. All assets are testnet tokens with no monetary value.
Yield figures shown are indicative — not financial advice.

We use third-party smart contracts (Hashnote, Circle, Arc Foundation) audited by their
respective teams. ArcSwap itself does not own or operate any contracts.

---

## License

License decision pending. Until then, all rights reserved by the ArcSwap team.

When we decide (likely **MIT** for the frontend), this section will update.

---

_Built on [Arc](https://arc.network) — the developer platform for onchain finance._
