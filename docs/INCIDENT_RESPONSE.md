# Incident Response Playbook — ArcSwap

When something breaks (or someone breaks it), this doc tells you exactly what to do
in what order. Read it now, not during the incident.

---

## Severity classification

| Severity | Definition | Response time | Examples |
|---|---|---|---|
| **SEV-1** | User funds at risk RIGHT NOW | **Acknowledge in 15 min, mitigate in 1 hour** | Frontend serving malicious JS, ENS hijacked, signer key compromised |
| **SEV-2** | App degraded but funds safe | Ack in 1h, mitigate in 4h | RPC down, vault display showing wrong APY, CCTP route failing |
| **SEV-3** | Single feature broken | Ack in 4h, mitigate in 24h | Faucet link 404s, one wallet provider not connecting |
| **SEV-4** | Cosmetic / non-blocking | Ack in 24h, fix in next release | Layout glitch, typo, slow load on slow networks |

**When in doubt, escalate up.** Better to wake someone unnecessarily than miss SEV-1.

---

## Roles during an incident

| Role | Responsibility | Default holder |
|---|---|---|
| **Incident Commander (IC)** | Decides actions, owns the timeline, single point of authority | First responder (escalates if needed) |
| **Comms Lead** | Updates status page, posts to Discord/Twitter, talks to users | Marketing / community lead |
| **Tech Lead** | Diagnoses, executes fixes, coordinates with other engineers | On-call engineer |
| **Scribe** | Logs everything in real-time (timestamps, actions, decisions) | Anyone available |

For a small team (1-3 people): one person can wear multiple hats — but **always name an IC explicitly**.

---

## SEV-1: Frontend supply-chain compromise

**Symptoms**:
- User reports a malicious approval popup appearing on arcswap.net
- Hash of served JS doesn't match committed CID
- Browser console shows scripts from unknown origins

### Step 1 — Confirm (5 min)

```bash
# Compare live build hash against last release manifest
curl -s https://arcswap.eth.limo/assets/arc-core.js | sha256sum
cat releases/RELEASE-*.json | jq -r '.ipfs_cid' | tail -1

# Check current ENS contenthash
cast call $ENS_PUBLIC_RESOLVER "contenthash(bytes32)" $(namehash arcswap.eth)
```

If the hash differs from the last signed release → **CONFIRMED COMPROMISE**.

### Step 2 — Take down (15 min)

- [ ] Multi-sig signers convene (Discord war-room channel)
- [ ] **Option A** — revert ENS contenthash to last known-good CID
- [ ] **Option B** — point ENS to a holding page (`bafkreih...holding`) saying "App is paused for security review. No action required."
- [ ] DNS-level: if using `arcswap.net` CNAME → swap to holding page directly

### Step 3 — Communicate (within 30 min)

Post in this order:
1. **Status page** (`status.arcswap.net`) — banner: "App temporarily paused — investigating"
2. **Twitter** — pinned thread: what happened, what we did, who's affected
3. **Discord** announcement channel — same message, no DMs (avoid impersonation)
4. **Email** to known users (if you have list) — same message

**Template**:
```
[INCIDENT] ArcSwap frontend paused — security investigation in progress.

What we know:
- At HH:MM UTC we detected [brief description]
- We have paused the app at the ENS / DNS level
- Smart contracts are unaffected (your funds in USYC vault are safe and accessible directly via Hashnote)
- No user action required

What we're doing:
- [Specific actions]

Next update: HH:MM UTC (within 2 hours)
```

### Step 4 — Investigate (1-4h)

- [ ] How did attacker push the bad build? Compromised signer? Build pipeline? CDN?
- [ ] What was the malicious behavior? (decompile JS, run in sandboxed VM)
- [ ] How many users may have been exposed? (analytics: unique visitors during window)
- [ ] Was anyone actually drained? (on-chain analysis of approvals from arcswap.net visitors)

### Step 5 — Recover (when safe)

- [ ] Rotate ALL credentials touched by the incident (signer keys, API tokens, GitHub tokens, deploy keys)
- [ ] Push a clean rebuild from a fresh dev machine (not the compromised one)
- [ ] New IPFS pin → multi-sig signs new ENS contenthash
- [ ] Verify hash matches expected
- [ ] Lift hold page

### Step 6 — Post-mortem (within 7 days)

Public blog post + GitHub issue. Include:
- Timeline (UTC, minute-by-minute)
- Root cause
- What worked, what didn't
- Action items with owners + dates

---

## SEV-1: Smart contract exploit (third-party)

USYC, CCTP, Uniswap router, etc. We don't own these but our users use them through us.

### Step 1 — Confirm
- [ ] Check vendor security channels (Hashnote / Circle / Arc Foundation status pages)
- [ ] Check Twitter for chatter from samczsun, blocksec, peckshield, etc.

### Step 2 — Mitigate
- [ ] Disable the affected feature in the frontend (kill switch — see below)
- [ ] Show banner explaining the situation, link to vendor advisory
- [ ] Do NOT speculate publicly — point users to vendor's official statement

### Step 3 — Implement frontend kill switch

We need a **feature flag system** for fast-disable. Suggested implementation:

```js
// assets/feature-flags.js  (loaded first, fetched fresh each time)
window.FEATURES = {
  vault_deposit:  true,
  vault_redeem:   true,
  swap:           true,
  bridge_cctp:    true,
  pool_add_liq:   true,
  pool_remove_liq: true,
};
```

Pin this file separately to IPFS — when an incident happens, multi-sig flips one flag and re-pins. Frontend reads flags at every interaction and hides disabled actions with a banner.

---

## SEV-2: RPC outage

**Symptoms**: Vault page shows "—" for all values, transactions fail with network error.

### Step 1 — Diagnose
```bash
# Test RPC directly
curl -X POST https://rpc.testnet.arc.network \
  -H "content-type: application/json" \
  -d '{"jsonrpc":"2.0","method":"eth_blockNumber","id":1}'

# Check Arc status page
open https://status.arc.network
```

### Step 2 — Fail over

If we have a backup RPC configured:
- [ ] Frontend's `ARC_RPC` already supports fallback array
- [ ] Push a new release with reordered RPC list (first item = backup)

If no backup configured yet:
- [ ] **Action item for ops**: configure a paid RPC (Alchemy / QuickNode) before mainnet

### Step 3 — Communicate
- [ ] Status page: "Arc RPC degraded — read-only mode" 
- [ ] Disable transaction-sending UI, leave read-only working

---

## Communication templates

### Initial alert (Twitter)
```
🚨 We're investigating an issue with [feature]. Funds in @arc_network contracts are unaffected. No action needed. Next update in 30 min.
```

### Resolution (Twitter)
```
✅ Resolved at HH:MM UTC. Root cause: [one sentence]. Full post-mortem within 7 days. Thanks for your patience.
```

### Status page snippet
```
[Investigating] [Identified] [Monitoring] [Resolved]
HH:MM UTC — Brief, factual update. No speculation. No blame.
```

---

## Contact tree

| Role | Primary | Secondary | Tertiary |
|---|---|---|---|
| Founder / IC | — | — | — |
| Tech Lead | — | — | — |
| Comms / Marketing | — | — | — |
| External — Hashnote | security@hashnote.com | — | — |
| External — Circle | https://circle.com/responsible-disclosure | — | — |
| External — Arc Foundation | security@arc.network | — | — |

> Fill in real names, phone numbers, Signal handles before going to mainnet.
> Print this page. Keep a copy offline. The incident may take down our usual comms.

---

## Tools to set up before going to mainnet

| Tool | Purpose | Free tier |
|---|---|---|
| **Tenderly** | Smart contract monitoring + alerts | 3 alerts free |
| **OpenZeppelin Defender** | Sentinel + autotask + admin proposals | Free up to limits |
| **Better Stack (Logtail / Uptime)** | Endpoint uptime, status page | Free tier |
| **PagerDuty / Grafana OnCall** | On-call rotation, escalation | Free for small teams |
| **Discord webhook** | Auto-post alerts to ops channel | Free |
| **Forta** | Decentralized threat detection on contracts | Free agents |

We'll wire these up as part of the mainnet readiness checklist (see `SECURITY_CHECKLIST.md`).

---

## Drills

Run an incident drill **once per quarter**. Pick a scenario from above, role-play it
end-to-end (no production changes — use a tabletop exercise). Time each step.
Update this playbook based on what you learn.

Last drill: _none yet_

---

_Last updated: 2026-04-25_
