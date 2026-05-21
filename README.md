# ArcSwap

> **The stablecoin command center on Arc.**
> One USDC. One Balance. Everywhere.

Unified balance across 8 chains · cross-chain settlement in ~30s · bounded autonomous agents — all native USDC, no wrappers.

🌐 Live at **[arcswap.net](https://arcswap.net)** · 🐦 [@arc_swap](https://x.com/arc_swap) · 💬 [Discord](https://discord.gg/7XUPdWWrGk)

---

## What is this?

ArcSwap is a **non-custodial stablecoin terminal** built on the [Arc Layer 1](https://arc.network) — Circle's institutional EVM chain where USDC is the native gas token. We treat USDC as **one programmable balance** rather than dozens of siloed per-chain wallets.

### What ships today on Arc Testnet

| Surface | What it does | Powered by |
|---|---|---|
| **Unified Balance** | See USDC across 8 chains as one number. Spend cross-chain via a single EIP-712 signature. | [Circle Gateway](https://www.circle.com/gateway) |
| **Trade** | Stablecoin swap on Arc (Uniswap V2) + CCTP bridge merged into one flow. Fast (~20s) or Standard (free) mode. | [Circle CCTP V2](https://www.circle.com/cross-chain-transfer-protocol) + [Circle App Kit](https://developers.circle.com/) |
| **Agent** | Bounded autonomous USDC operations. Pre-sign EIP-712 intents with hard ceilings; software executes within those bounds. | [Circle Programmable Wallets](https://developers.circle.com/w3s/programmable-wallets) |

### Coming soon

| Surface | When | Notes |
|---|---|---|
| **Balance + Agent + Trade** | Q2 2026 | Unified balance flow polish, Agent UX hardening (intents, approvals, revoke), and route/quote optimization. |
| **Dashboard** | Q3 2026 | Public operator console with portfolio, balances, agents, and activity in one unified view. |
| **Circle Wallets onboarding** | Q4 2026 | Embedded sign-in via Circle Programmable Wallets for non-crypto users, plus mobile onboarding support. |
| **StableFX + Nanopayments + Agent SDK** | 2027+ | RFQ-driven stablecoin settlement, streaming USDC primitives, and Agent SDK general availability. |

> All surfaces are built on **Arc Testnet** first. Production cutover follows **Arc Mainnet** (targeted Summer 2026 per Circle’s Arc whitepaper).

You always retain custody. ArcSwap never holds funds, and the agent backend executes only within EIP-712-signed bounds you can revoke at any time.

---

## Circle integration map

Every Circle product we use is integrated **natively** — no third-party bridges, no wrapped derivatives.

| Circle product | Status | Where in code |
|---|---|---|
| **USDC** | Live | Native unit of account across every surface. Per-chain addresses in [`assets/arc-core.js`](assets/arc-core.js#L172-L233). |
| **Circle Gateway** | Live (testnet) | EIP-712 `BurnIntent` signing + 8-chain `/v1/balances` aggregation. See [`assets/arc-gateway.js`](assets/arc-gateway.js#L27-L52) and [`functions/api/gateway-proxy/`](functions/api/gateway-proxy/). |
| **CCTP V2** | Live (testnet) | `TokenMessengerV2.depositForBurn` + `MessageTransmitterV2.receiveMessage`, Fast and Standard modes. See [`assets/arc-core.js`](assets/arc-core.js#L39-L40) and [`trade.html`](trade.html#L1436-L1483). |
| **Programmable Wallets** | Live (testnet) | Developer-Controlled Wallets API for the Agent backend — RSA-OAEP `entitySecretCiphertext`, per-chain wallet provisioning, USDC transfers. See [`functions/api/agent/_circle.js`](functions/api/agent/_circle.js). |
| **App Kit (Stablecoin Kit)** | Live (testnet) | In-Arc swap routing proxied via [`functions/api/circle-proxy/`](functions/api/circle-proxy/) so the API key never reaches the browser. |
| **Nanopayments** | Planned (2027+) | Streaming USDC primitives — Agent SDK foundation. |

Supported chains for Unified Balance and CCTP V2: **Arc, Ethereum, Base, Arbitrum, Optimism, Polygon, Avalanche, Unichain** (all testnets today).

---

## Tech stack

**Frontend**
- Pure HTML + CSS + vanilla JavaScript — no framework, no build step
- [ethers.js v6](https://docs.ethers.org/v6/) — only external runtime dependency (SRI-pinned CDN)
- EIP-6963 multi-wallet detection (MetaMask, Rabby, Coinbase Wallet, OKX, Brave)

**Backend (Cloudflare Pages Functions)**
- `functions/api/gateway-proxy/` — server-side proxy to Circle Gateway REST (`gateway-api-testnet.circle.com`)
- `functions/api/circle-proxy/` — proxies Circle App Kit (`api.circle.com`) so `KIT_KEY` stays out of the browser
- `functions/api/agent/` — Agent CRUD endpoints backed by Cloudflare KV (`AGENT_KV`)
- `functions/api/agent/_circle.js` — Circle Programmable Wallets integration (wallet provisioning, USDC transfers)
- `workers/agent-cron/` — scheduled Cloudflare Worker that fires agent rules on cadence

**Infra**
- **Cloudflare Pages** — hosting + CDN + DDoS protection
- **Cloudflare KV** — agent rule storage
- **Optional: IPFS + ENS** — decentralized backup (see [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md))

First paint < 1s on 4G. No `node_modules` in production.

---

## Local development

```bash
# Clone
git clone https://github.com/nhutqui23091/arcswap.git
cd arcswap

# Serve locally — any static server works
python3 -m http.server 8080            # Python
npx serve .                            # Node
php -S localhost:8080                  # PHP
```

Open `http://localhost:8080` in a browser with MetaMask/Rabby installed. Grab testnet USDC from [faucet.circle.com](https://faucet.circle.com).

For full backend behavior (Agent, Gateway proxy, App Kit proxy):

```bash
# Requires Wrangler — Cloudflare's CLI
npm install -g wrangler
wrangler pages dev .
```

Set these env vars in `.dev.vars` for local backend testing (see `.env.example`):

```
CIRCLE_API_KEY=...           # Circle Programmable Wallets bearer token
CIRCLE_ENTITY_SECRET=...     # 64-hex entity secret (raw)
KIT_KEY=...                  # Circle App Kit API key
GATEWAY_KEY=...              # Optional — Gateway bearer if Circle requires it
```

No keys are needed for read-only frontend dev.

---

## Deployment

**Primary path** — Cloudflare Pages: see [`docs/DEPLOY_CLOUDFLARE.md`](docs/DEPLOY_CLOUDFLARE.md)
**Optional path** — IPFS + ENS (immutable): see [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md)

Before any deploy, run the pre-flight check:

```bash
bash scripts/preflight-check.sh
```

Verifies CSP, SRI, secrets hygiene, redirects, and host headers.

---

## Project structure

```
arcswap/
├── index.html              ← Homepage
├── balance.html            ← Unified Balance (Circle Gateway)         [LIVE]
├── trade.html              ← Swap + CCTP V2 Bridge                    [LIVE]
├── agent.html              ← Autonomous agents (EIP-712 + PW)         [LIVE]
├── dashboard.html          ← Operator console                         [SOON]
│
├── assets/
│   ├── arc-core.js         ← Shared on-chain helpers (RPC, ABIs, USDC addresses, EIP-6963)
│   ├── arc-gateway.js      ← Circle Gateway client (EIP-712 BurnIntent + /v1/balances)
│   ├── arc-appkit.js       ← Circle App Kit client (in-Arc swap routing)
│   ├── arc-ui.js, arc-ui.css ← Shared UI primitives
│   └── social/             ← X avatar + cover SVGs
│
├── functions/api/
│   ├── gateway-proxy/      ← Server-side proxy → Circle Gateway REST
│   ├── circle-proxy/       ← Server-side proxy → Circle App Kit (KIT_KEY)
│   └── agent/              ← Agent CRUD + Programmable Wallets backend
│       ├── [[path]].js     ← Routes (create, list, pause, resume, run-now, executions)
│       ├── _circle.js      ← Circle Developer-Controlled Wallets API integration
│       └── _balance.js     ← USDC balance checks per chain
│
├── workers/
│   └── agent-cron/         ← Scheduled execution worker (Cloudflare Cron Trigger)
│
├── docs.html, blog.html, point.html, token.html, deploy.html  ← Static pages
│
├── _headers, _redirects    ← Cloudflare Pages security + clean URLs
├── docs/                   ← Deployment + governance + incident-response runbooks
├── scripts/                ← Pre-flight + health-check + IPFS deploy helpers
├── .well-known/security.txt
├── SECURITY.md, SECURITY_CHECKLIST.md
├── SETUP-AGENT.md          ← One-time setup for the Agent backend (KV + Circle keys)
└── .env.example
```

> **Note:** Earlier surfaces (`vault.html`, `pool.html`, `swap.html`, `bridge.html`) remain in the repo for historical reference. They are not part of the current product and will be removed in a future cleanup pass.

---

## Security

- Content-Security-Policy on every page
- Subresource Integrity on every CDN script
- Strict referrer + permissions policies via `_headers`
- API keys never reach the browser (server-side proxies for App Kit + Programmable Wallets)
- Origin allowlist on every Pages Function
- Multi-sig governance for any privileged action (see [`docs/GOVERNANCE.md`](docs/GOVERNANCE.md))

**Found a vulnerability?** See [`SECURITY.md`](SECURITY.md). Bounties from $100 to $50,000.
Contact: `security@arcswap.net` (PGP key in `SECURITY.md`).

---

## Roadmap

ArcSwap builds on **Arc Testnet** today. The calendar quarters below reflect
testnet engineering milestones we control. **Production cutover to Arc Mainnet
follows Arc's own launch** — Circle targets **Summer 2026** per the Arc whitepaper.

| Quarter | What we ship (on Arc Testnet) |
|---|---|
| **Q2 2026** | Dashboard GA · Security audit kickoff · Unified Balance polish · agent UX hardening |
| **Q3 2026** | Deeper Circle Wallets onboarding (Circle Programmable Wallets) · WalletConnect / Reown for mobile · activity points |
| **Q4 2026** | **StableFX** build — RFQ-driven USDC ⇄ EURC settlement on Arc FxEscrow · Treasury API preview |
| **2027+** | Circle Nanopayments + streaming USDC · Agent SDK GA · Treasury API GA |

> **Production cutover.** When Arc launches Mainnet (targeted Summer 2026), Unified Balance, Trade, and Agent migrate to Arc Mainnet production in lock-step, and Circle Wallets embedded sign-in activates for non-crypto users.

See live roadmap on the [homepage](https://arcswap.net/#roadmap).

---

## Disclaimer

ArcSwap is **testnet-only** software. All assets are testnet tokens with no monetary value. Indicative yields and execution timings are not guarantees — actual results depend on Circle infrastructure, network conditions, and on-chain liquidity.

We use third-party smart contracts (Circle Gateway, Circle CCTP, Uniswap V2 deployed by Arc Foundation) audited by their respective teams. ArcSwap itself does not own or operate any of these contracts.

---

## License

License decision pending. Until then, all rights reserved by the ArcSwap team. When we decide (likely **MIT** for the frontend, **Apache-2.0** for backend functions), this section will update.

---

_Built on [Arc](https://arc.network) — the developer platform for onchain finance. Powered by [Circle](https://www.circle.com/) primitives end-to-end._
