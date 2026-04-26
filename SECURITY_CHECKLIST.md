# ArcSwap — Security Readiness Checklist

A single-page index of every security control we ship, what's done, and what
**you (the human)** still need to do externally before mainnet.

Updated: **2026-04-25**

---

## Legend

- ✅ **Done** — committed in this repo, no further action
- 🟡 **Config needed** — code is ready; you fill in keys / accounts / signers
- 🔴 **External / paid** — requires registration, payment, or coordination outside the repo
- ⏳ **Future** — only relevant when we deploy our own contracts

---

## Stage 1 — Baseline (testnet, ✅ done)

These ship with every build today.

| Control | Status | Where |
|---|---|---|
| Content Security Policy meta tag in every HTML | ✅ | All `*.html` |
| Subresource Integrity on all CDN scripts | ✅ | `index.html`, `vault.html`, `trade.html` |
| `rel="noopener noreferrer"` on every `target="_blank"` | ✅ | All HTML + JS |
| No hardcoded secrets in tracked files | ✅ | enforced by `scripts/preflight-check.sh` |
| `.env` excluded from git | ✅ | `.gitignore` + preflight check |
| Strict referrer policy | ✅ | meta tag + `_headers` |
| Host security headers (CSP, HSTS, X-Frame, X-Content, COOP/CORP) | ✅ | `_headers`, `vercel.json` |
| Vulnerability disclosure policy | ✅ | `SECURITY.md` |
| RFC 9116 `security.txt` | ✅ | `.well-known/security.txt` |
| Pre-deploy audit script | ✅ | `scripts/preflight-check.sh` |
| Endpoint health probe | ✅ | `scripts/health-check.sh` |

**To verify**: run `bash scripts/preflight-check.sh` — expect all 6 ✓.

---

## Stage 2 — Pre-mainnet hardening

### 2A. Production hosting

#### Path A — Cloudflare Pages (primary, ✅ ready)

| Step | Status | Action |
|---|---|---|
| Domain `arcswap.net` purchased on Cloudflare | ✅ | Done |
| Deploy guide | ✅ | `docs/DEPLOY_CLOUDFLARE.md` |
| `_headers` + `_redirects` configured | ✅ | At repo root, honored by Pages |
| **Create Pages project + connect repo** | 🟡 | Cloudflare dashboard → Workers & Pages → Connect Git. ~5 min. |
| **Wire `arcswap.net` to Pages project** | 🟡 | Custom domains tab → add `arcswap.net` and `www.arcswap.net`. ~5 min. |
| **Enable Email Routing for `security@arcswap.net`** | 🟡 | Cloudflare Email tab → forward to your inbox. ~5 min. |
| **Verify SSL/TLS = Full (strict)** | 🟡 | SSL/TLS tab. Default may be "Flexible" which causes 525 errors. |
| **Disable Rocket Loader** | 🟡 | Speed → Optimization. It rewrites JS and breaks SRI. |

**Estimated cost**: $0/month + ~$10/year domain (already purchased).

#### Path B — IPFS + ENS (optional immutable backup, do later)

| Step | Status | Action |
|---|---|---|
| Deploy script ready | ✅ | `scripts/deploy-ipfs.sh` |
| Deploy runbook | ✅ | `docs/DEPLOYMENT.md` |
| **Register `arcswap.eth` ENS** | 🔵 | Optional. Visit https://app.ens.domains, ~$5/year. |
| **Web3.storage + Pinata accounts** | 🔵 | Optional. Free tier OK. |
| First IPFS pin + ENS update | ⏳ | Only when going to mainnet. |

**Recommendation**: Path A is enough for testnet and early mainnet. Add Path B as a parallel
audit-trail when handling real money or when users start asking for verifiable hashes.

---

### 2B. Multi-sig governance

| Step | Status | Action |
|---|---|---|
| Multi-sig policy doc | ✅ | `docs/GOVERNANCE.md` |
| **Treasury Safe (3 of 5)** | 🔴 | Deploy on Arc Testnet via https://app.safe.global. Signers: 2 founders + CTO + community rep + advisor. |
| **ENS Controller Safe (2 of 3)** | 🔴 | Same flow. Signers: 2 founders + cold backup. |
| **Hardware wallets for every signer** | 🔴 | Ledger Nano S+ (~$80) or Trezor One (~$70). One per signer. |
| **Cold backup for ENS Safe** | 🔴 | Printed seed phrase in safe deposit box. |
| **Document signer info** | 🟡 | Encrypted vault (1Password / Bitwarden). Names, hardware models, response times. |
| Test transaction (0.001 USDC from each Safe) | ⏳ | Verify each signer can sign; verify execution. |
| Publish Safe addresses | ⏳ | Add to `governance/safes.json` + website footer. |

**Estimated cost**: ~$300 in hardware wallets + ~$5 gas to deploy each Safe.

---

### 2C. Bug bounty program

| Step | Status | Action |
|---|---|---|
| Vulnerability disclosure policy | ✅ | `SECURITY.md` (with bounty ranges) |
| Hall of Fame placeholder | ✅ | `SECURITY.md#hall-of-fame` |
| **`security@arcswap.net` mailbox** | 🔴 | Forward to founders' personal emails. Set up PGP key. |
| **Publish PGP public key** | 🟡 | Replace placeholder in `SECURITY.md` + `security.txt` |
| **Immunefi listing** | 🔴 | Apply at https://immunefi.com/explore/?type=bug-bounty — free to list, requires bounty pool funded in advance. |
| **Fund bounty pool** | 🔴 | Recommended: $50k USDC in Treasury Safe earmarked for bounties. |
| **Define program scope** | 🟡 | Mirror `SECURITY.md` scope; explicitly exclude vendor contracts. |
| Public announcement | ⏳ | Tweet + Discord post when live. |

**Estimated cost**: ~$50k bounty pool (only paid when valid bug found) + Immunefi takes 10% of payouts.

---

### 2D. Monitoring + incident response

| Step | Status | Action |
|---|---|---|
| Incident response playbook | ✅ | `docs/INCIDENT_RESPONSE.md` |
| Health-check script | ✅ | `scripts/health-check.sh` |
| Severity classification (SEV-1..4) | ✅ | `INCIDENT_RESPONSE.md` |
| Communication templates | ✅ | `INCIDENT_RESPONSE.md` |
| **Better Stack uptime + status page** | 🔴 | https://betterstack.com — free tier (10 monitors, 1 status page). Wire `health-check.sh` as a heartbeat URL. |
| **PagerDuty / Grafana OnCall** | 🔴 | https://grafana.com/products/oncall/ — free for small teams. Define escalation policy. |
| **Discord webhook for alerts** | 🟡 | Create `#ops-alerts` channel, paste webhook URL in `.env` as `ALERT_WEBHOOK` |
| **Tenderly project + alerts** | 🟡 | https://tenderly.co — free tier: 3 alerts. Watch USYC Teller, CCTP TokenMessenger, Uniswap Router. |
| **OpenZeppelin Defender Sentinels** | 🟡 | https://defender.openzeppelin.com — free up to limits. |
| **Schedule cron for health-check** | 🔴 | `*/5 * * * *  bash /opt/arcswap/scripts/health-check.sh` on a small VPS, OR run via GitHub Actions every 5 min. |
| **Fill in contact tree** | 🔴 | `INCIDENT_RESPONSE.md` — real names, Signal handles, phone numbers. Print + keep offline copy. |
| **First incident drill** | ⏳ | Tabletop exercise. Pick SEV-1 frontend compromise, role-play it. |

**Estimated cost**: $0/month with free tiers. ~$10-20/month for a small VPS to run cron.

---

### 2E. Pre-mainnet penetration test

| Step | Status | Action |
|---|---|---|
| **Hire pentest firm for frontend audit** | 🔴 | Trail of Bits, ConsenSys Diligence, OpenZeppelin — ~$15-40k for 1-2 week engagement. Focus: XSS, supply-chain, signing UX, transaction tampering. |
| **Public testnet bug bash** | 🔴 | 2-week incentivized testing window. ~$5-10k in rewards. |
| **Fix all P1/P2 findings** | ⏳ | Block mainnet on this. |
| **Publish audit report** | ⏳ | Add to `audits/` directory + link from website footer. |

---

## Stage 3 — Mainnet launch gating

Don't ship to mainnet until ALL of the following are ✅:

- [ ] All Stage 1 ✅ items still pass `preflight-check.sh`
- [ ] ENS `arcswap.eth` registered + controlled by multi-sig
- [ ] At least 2 IPFS pinning providers funded (one paid, one free backup)
- [ ] Treasury + ENS Controller Safes deployed, tested, documented
- [ ] All signers using hardware wallets (no hot keys on multi-sigs)
- [ ] `security@arcswap.net` live + PGP key published
- [ ] Immunefi program live with funded bounty pool
- [ ] Pentest complete, all P1/P2 fixed, report public
- [ ] Health-check cron running, Discord alerts firing on failure
- [ ] Status page live at `status.arcswap.net`
- [ ] Incident response contact tree filled in (real names, real numbers)
- [ ] Quarterly drill scheduled on calendar
- [ ] Insurance policy researched (Nexus Mutual / Sherlock — optional but recommended)

---

## Stage 4 — Post-launch (ongoing)

| Cadence | Task |
|---|---|
| **Daily** | Review health-check + Tenderly alerts |
| **Weekly** | Review pending bug bounty reports (≤7 days SLA) |
| **Monthly** | Rotate any short-lived API tokens (web3.storage, Pinata) |
| **Quarterly** | Incident response drill (tabletop) |
| **Quarterly** | Signer OpSec review (assume one signer compromised — can rest still operate?) |
| **Every 6 months** | Multi-sig signer review (rotate inactive, onboard new) |
| **Yearly** | External re-audit of frontend (lighter scope, ~$5-10k) |
| **Yearly** | Renew ENS registration |
| **As needed** | Post-mortem within 7 days of any incident → public blog post |

---

## ⏳ Stage 5 — When we deploy our own contracts

We currently use **third-party contracts only** (Hashnote USYC, Circle CCTP, Uniswap V2).
If/when we ship our own (custom Pool, Swap router, Vault wrapper, etc.), add:

| Step | Action |
|---|---|
| **Smart contract audit** | 2-3 firms in parallel for critical contracts. Budget: $50-200k each. Firms: Trail of Bits, OpenZeppelin, ConsenSys Diligence, Spearbit, Sigma Prime, Zellic. |
| **Formal verification** | Certora for math-heavy contracts (e.g. AMM invariants). |
| **Testnet bug bounty** | 4-week public bounty with rewards before mainnet deploy. |
| **Contract Owner Safe (4 of 7)** | Founders + advisors + auditor. Owns admin/pause/upgrade. |
| **Timelock wrapper (48h)** | OpenZeppelin TimelockController in front of Owner Safe. |
| **Pause guardian (1 of N)** | Faster reaction for emergencies — pause-only, no other powers. |
| **Forta agents** | Detection bots for anomalies (e.g. >10% TVL drop in 1 block). |
| **Formal incident playbook for contract exploit** | Add to `INCIDENT_RESPONSE.md` |

---

## TL;DR — What you (Khoa) need to do this week

If you only have an hour right now, do these in order:

1. **Push repo to GitHub** (if not yet) — Cloudflare Pages reads from Git (5 min)
2. **Set up Cloudflare Pages** — connect repo, deploy (5 min, see `docs/DEPLOY_CLOUDFLARE.md`)
3. **Wire `arcswap.net` to the Pages project** — Custom Domains tab (5 min)
4. **Enable Email Routing** for `security@arcswap.net` → your inbox (5 min)
5. **Set SSL/TLS = Full (strict)** + disable Rocket Loader (2 min)
6. **Run `bash scripts/health-check.sh`** — confirm `arcswap.net` is healthy (1 min)

That gets you a live, secure, free production deployment. Everything else (multi-sig,
ENS, hardware wallets, Immunefi) can wait until you're closer to mainnet.

---

_See also: `docs/DEPLOY_CLOUDFLARE.md` (primary deploy), `docs/DEPLOYMENT.md` (optional IPFS+ENS),
`SECURITY.md` (disclosure policy), `docs/GOVERNANCE.md` (multi-sig), `docs/INCIDENT_RESPONSE.md` (playbook)._
