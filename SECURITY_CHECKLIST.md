# ArcSwap — Security Posture

A public summary of the security controls that ship with every build of ArcSwap,
and the principles we apply across the lifecycle of the project.

For vulnerability reporting, see [`SECURITY.md`](SECURITY.md).
For multi-sig governance, see [`docs/GOVERNANCE.md`](docs/GOVERNANCE.md).

---

## Threat model

ArcSwap is a **non-custodial frontend** for stablecoin primitives on Arc Testnet.
It owns no smart contracts of its own; users always sign their own transactions
against third-party protocols (Hashnote USYC, Circle CCTP / Gateway, Uniswap V2).

The threats we design against:

| Threat | Why it matters | Where we defend |
|---|---|---|
| **Frontend supply-chain compromise** | Attacker swaps served JS → injects malicious approve / transfer | CSP, SRI, host integrity, multi-host failover |
| **DNS / domain hijack** | Attacker points `arcswap.net` to a phishing build | Cloudflare 2FA + multi-sig over decentralized backup (ENS) |
| **Reflected / persistent XSS** | Script execution leads to wallet drain | CSP, no `innerHTML` for user input, SRI on all CDN scripts |
| **API key extraction** | Attacker exfiltrates Circle Kit Key from client JS | Server-side proxy via Cloudflare Pages Functions |
| **Transaction tampering at sign-time** | UI lies about tx parameters | Show full target + calldata in confirmations; encourage hardware-wallet review |
| **Vendor contract exploit** | USYC / CCTP / Uniswap bug surfaces in our UI | Frontend kill-switch via feature flags; advisory banners |

Out of scope: chain-level attacks on Arc L1, attacks on third-party contracts
(those have their own disclosure channels — see [`SECURITY.md`](SECURITY.md)).

---

## Controls in every build

These controls are enforced by [`scripts/preflight-check.sh`](scripts/preflight-check.sh) before any deploy.

| Control | Mechanism |
|---|---|
| **Content Security Policy** | `<meta http-equiv="Content-Security-Policy">` on every HTML file, plus belt-and-braces `Content-Security-Policy` header in [`_headers`](_headers) |
| **Subresource Integrity** | Every external script tag carries a SHA-384 `integrity=` attribute; mismatched hashes are refused by the browser |
| **`rel="noopener noreferrer"`** | On every `target="_blank"` link in HTML and dynamic anchors in JS |
| **Strict referrer policy** | `Referrer-Policy: strict-origin-when-cross-origin` |
| **Host security headers** | HSTS (1y, includeSubDomains, preload), X-Frame-Options DENY, X-Content-Type-Options nosniff, COOP/CORP, Permissions-Policy (camera/mic/geolocation off) |
| **No secrets in tracked files** | `.env` is gitignored; preflight script greps for common API-key patterns and fails the build on match |
| **Server-side API key handling** | Circle Kit Key and any other privileged key sit in Cloudflare environment secrets and are injected by Pages Functions proxies; the browser never sees them |
| **HTTPS only** | `Strict-Transport-Security` + `Always Use HTTPS` rule at the edge; no plaintext fallback |
| **Vulnerability disclosure** | [`SECURITY.md`](SECURITY.md) + [RFC 9116](https://datatracker.ietf.org/doc/html/rfc9116) `.well-known/security.txt` |

---

## Verifying a build yourself

Anyone can verify these controls on a live deploy:

```bash
# Security headers
curl -sI https://arcswap.net | grep -iE 'content-security|strict-transport|x-frame|referrer-policy|permissions-policy'

# CSP meta tag in HTML
curl -s https://arcswap.net | grep -oE '<meta http-equiv="Content-Security-Policy"[^>]*>'

# SRI on every CDN script
curl -s https://arcswap.net | grep -oE '<script[^>]*src="https://[^"]*"[^>]*integrity="[^"]*"'
```

For local development, run the preflight script before pushing:

```bash
bash scripts/preflight-check.sh
```

---

## Defense in depth

### Hosting

The primary deploy is **Cloudflare Pages** with the orange-cloud proxy enabled —
this gives us the global CDN, DDoS protection, free TLS, and atomic rollback.
All site headers and redirects are owned by [`_headers`](_headers) and [`_redirects`](_redirects)
in the repo, so the deployed configuration is 1:1 with what is reviewed and committed.

For an **immutable audit trail**, the same build can be pinned to IPFS and resolved
through ENS (`arcswap.eth`) — a pattern used by Uniswap, 1inch, Aave, and other
DeFi frontends. See [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md) for the runbook.

### Privileged actions

Anything that affects production state — domain configuration, ENS contenthash,
treasury funds — is held by **multi-signature wallets** with hardware-wallet
signers. No single key can move funds, change DNS, or push a build.
See [`docs/GOVERNANCE.md`](docs/GOVERNANCE.md) for the policy.

### Frontend kill-switch

The frontend reads a feature-flag manifest at runtime. Any individual product
surface (vault deposit / redeem, swap, bridge, pool actions) can be disabled
without a code push if a vendor contract incident is reported or if we need
to gate access for any reason.

---

## Vendor surfaces & their disclosure channels

ArcSwap composes third-party contracts. Vulnerabilities in those contracts are
out of scope for our bounty — please report them upstream:

| Surface | Owner | Report to |
|---|---|---|
| USDC, EURC, CCTP, Gateway | Circle | <https://www.circle.com/legal/responsible-disclosure> |
| USYC, Teller, Entitlements | Hashnote | <security@hashnote.com> |
| Uniswap V2 Router/Factory on Arc | Arc Foundation | <security@arc.network> |
| Permit2 | Uniswap Labs | <security@uniswap.org> |
| Arc L1 chain | Arc Foundation | <security@arc.network> |

For anything in **our** scope (the frontend itself, build pipeline, headers,
proxies), see [`SECURITY.md`](SECURITY.md).

---

## Mainnet readiness

ArcSwap is currently **testnet-only**. Before any mainnet release, the project
will additionally complete:

- Public security audit by an established firm
- Funded bug-bounty program with published scope
- Treasury and infrastructure multi-sigs deployed and tested on mainnet
- Public PGP key + verified `security@` mailbox
- Status page + on-call rotation
- Incident-response drill log

These are tracked internally and announced publicly when each milestone lands.

---

## Open principles

- **Minimum dependency surface** — vanilla HTML + CSS + JS, one runtime dependency (ethers.js v6, SRI-pinned), no build step
- **No backend that can pause user access** — all state is on-chain; the proxies we ship are stateless and replaceable
- **Transparent incidents** — any incident is followed by a public post-mortem within 7 days
- **Reproducible builds** — what is committed is what is served; preflight enforces this

---

_Last updated: 2026-05-10_
