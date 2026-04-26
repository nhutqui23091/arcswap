# Governance & Multi-sig Policy — ArcSwap

This document defines who controls what, and how changes are made.
**Every privileged key MUST be a multi-sig.** No single person can move funds,
upgrade contracts, or change DNS / ENS records.

---

## Why multi-sig?

| Risk | Single-key (EOA) | Multi-sig (Safe) |
|---|---|---|
| Founder loses seed phrase | All funds gone | N-1 signers can recover |
| Founder hacked / coerced | Attacker controls everything | Needs M signers compromised |
| Founder leaves / disappears | Project dead | Other signers continue |
| Insider rug-pull | Possible | Requires conspiracy of M people |
| Hot wallet phishing | One sig = drained | Attacker needs M sigs from M devices |

**Industry standard**: every top-100 DeFi protocol uses Safe (formerly Gnosis Safe).
Cost: free to deploy (~$5-20 in gas), no ongoing fees.

---

## Keys & their owners

| Key | What it controls | Threshold | Signers |
|---|---|---|---|
| **Treasury Safe** | Bug bounty pool, ops budget, emergency funds | 3 of 5 | Founders + community |
| **Cloudflare account** | `arcswap.net` DNS + Pages deployment (the production frontend) | N/A (account-level 2FA) | Hardware key + recovery codes |
| **Future: ENS Controller Safe** | `arcswap.eth` contenthash (decentralized backup frontend) | 2 of 3 | Founders only |
| **Future: Pinning provider accounts** (web3.storage, Pinata) | IPFS pin lifecycle | N/A (account-level 2FA) | Same hardware key |
| **Future: Contract Owner Safe** | When we deploy own contracts (admin, pause, upgrade) | 4 of 7 | Founders + advisors + auditors |
| **Future: Timelock Controller** | Wraps Contract Owner Safe — adds 48h delay before execution | (controlled by Contract Owner Safe) | — |

---

## Setting up a Safe on Arc Testnet

### Step 1 — Visit Safe app

1. Go to https://app.safe.global
2. Connect a hardware wallet (Ledger / Trezor / Frame)
3. Create new Safe
4. Network: **Arc Testnet** (chainId 5042002) — add custom network if not listed

### Step 2 — Configure signers

For the **ENS Controller Safe** (2 of 3) example:
- Signer 1: Founder A's hardware wallet
- Signer 2: Founder B's hardware wallet  
- Signer 3: Cold backup (printed seed in safe deposit box, only used for recovery)

For the **Treasury Safe** (3 of 5):
- Signers 1-2: Founders
- Signer 3: CTO / lead engineer
- Signer 4: Community-elected representative (rotates yearly)
- Signer 5: Independent advisor (often an angel investor or auditor)

### Step 3 — Test a transaction

Before transferring real assets:
1. Send 0.001 USDC from Safe to a test address
2. Verify each signer can sign in their wallet
3. Verify execution works on-chain

### Step 4 — Document signer info

In a private (encrypted) repo or 1Password vault:
- Signer name + role
- Hardware wallet model + serial
- Backup recovery method
- PGP public key for encrypted comms
- Expected response time (e.g., "<24h on weekdays")

---

## Adding a Timelock (later, when we have own contracts)

A **Timelock** wraps the Safe and forces a delay between proposal and execution.

```
User → Safe (4/7 sigs) → Timelock (48h delay) → Contract.upgrade()
```

Benefits:
- Community sees pending changes 48h in advance → can exit if malicious
- Reduces blast radius if multi-sig is compromised
- Industry standard (Compound, Aave, Uniswap all use timelocks)

Use **OpenZeppelin TimelockController** — battle-tested, standard.

---

## Signer rotation policy

- Review signers **every 6 months**
- Remove inactive signers (>3 months unresponsive)
- Onboard new signers via test transactions before granting power
- All changes logged in `governance/signer-changes.md`

---

## Emergency procedures

### If a signer's key is compromised

1. **Immediately** — remaining signers create a tx to remove the compromised signer
2. Sign + execute (lower threshold temporarily if needed)
3. Add a fresh hardware wallet as replacement
4. Move any funds the compromised signer might still have access to
5. Post-mortem in `incidents/`

### If multiple signers compromised simultaneously

This is the worst case. Mitigations:
- **Geographic distribution** — signers in different countries
- **Vendor diversity** — not all Ledger or all Trezor
- **OpSec review every quarter** — assume one signer is compromised, can the rest still operate safely?

---

## Public verification

All Safe addresses are published in `governance/safes.json` and on the website
footer. Anyone can verify on-chain that:

- Signers are who we claim they are (ENS names where possible)
- Threshold matches policy
- Recent transactions match what we've publicly announced

Transparency is the security feature.

---

_Last updated: 2026-04-25_
