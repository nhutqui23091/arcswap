# Security Policy — ArcSwap

ArcSwap is the Yield Terminal for stablecoins on **Arc Testnet**. We take security
seriously and welcome responsible disclosure from researchers.

---

## Scope

### In-scope
- Frontend: `https://arcswap.net` and all subdomains
- IPFS-pinned builds (CIDs published in releases)
- Public assets at `/assets/*`

### Out-of-scope (third-party — report to vendor)
| Asset | Owner | Report to |
|---|---|---|
| USDC, EURC, CCTP, Gateway | Circle | https://www.circle.com/legal/responsible-disclosure |
| USYC, Teller, Entitlements | Hashnote | security@hashnote.com |
| UniswapV2 Router/Factory on Arc | Arc Foundation | security@arc.network |
| Permit2 | Uniswap Labs | security@uniswap.org |
| Arc L1 chain itself | Arc Foundation | security@arc.network |

---

## Reporting a vulnerability

**Preferred channel**: encrypted email to **security@arcswap.net** (PGP key below).

**Do NOT**:
- Open a public GitHub issue
- Disclose on Twitter / Discord before we patch
- Test against mainnet contracts (testnet only — see scope)

**Please include**:
1. Type of issue (XSS, supply chain, frontend phishing vector, RPC injection, etc.)
2. Affected URL / file / commit hash
3. Step-by-step reproduction
4. Proof-of-concept (screenshots, video, or code)
5. Impact assessment
6. Suggested mitigation (optional)

We acknowledge reports within **48 hours** and aim to triage within **5 business days**.

---

## Severity & rewards

We are launching an Immunefi bug bounty program. Indicative ranges (USDC):

| Severity | Reward range |
|---|---|
| **Critical** — frontend supply-chain compromise, key extraction, fund-draining tx injection | $10,000 – $50,000 |
| **High** — persistent XSS leading to wallet drain, DNS / build-pipeline takeover | $2,500 – $10,000 |
| **Medium** — reflected XSS, CSP bypass, auth bypass on admin routes | $500 – $2,500 |
| **Low** — clickjacking, missing security headers, info disclosure | $100 – $500 |

Final reward determined by impact + report quality + originality.

---

## Safe harbor

We will not pursue legal action against researchers who:
- Make a good-faith effort to avoid privacy violations, data destruction, or
  service interruption
- Only interact with their own accounts or test accounts
- Give us reasonable time to respond before public disclosure (90 days default)
- Do not exploit the vulnerability beyond what is necessary to prove it

---

## Hall of Fame

Researchers who responsibly disclose valid issues will be credited here
(unless they request anonymity).

| Researcher | Severity | Date | CVE / ID |
|---|---|---|---|
| _(none yet)_ | | | |

---

## PGP key

```
-----BEGIN PGP PUBLIC KEY BLOCK-----
[TODO: generate key with `gpg --full-generate-key` and paste here]
-----END PGP PUBLIC KEY BLOCK-----
```

Fingerprint: `TODO`

---

## Past incidents

None. This file will be updated transparently if and when an incident occurs.

---

_Last updated: 2026-04-25_
