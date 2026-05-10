# Incident Response Policy — ArcSwap

This document is the **public summary** of how ArcSwap classifies, contains, and
communicates security incidents. The internal playbook (with on-call contacts,
specific tooling, and rotation schedules) is maintained privately.

For vulnerability reporting, see [`SECURITY.md`](../SECURITY.md).

---

## Severity classification

| Severity | Definition | Response time |
|---|---|---|
| **SEV-1** | User funds at risk right now (frontend serving malicious code, domain hijack, signer-key compromise) | Acknowledge ≤ 15 min, mitigate ≤ 1 hour |
| **SEV-2** | App degraded but funds safe (RPC outage, vault values stale, CCTP route failing) | Acknowledge ≤ 1 hour, mitigate ≤ 4 hours |
| **SEV-3** | Single feature broken (one wallet provider, one chain, one link) | Acknowledge ≤ 4 hours, mitigate ≤ 24 hours |
| **SEV-4** | Cosmetic / non-blocking (typo, layout glitch, slow load) | Acknowledge ≤ 24 hours, fix in next release |

When the severity is unclear we escalate up, not down.

---

## Roles

For any incident above SEV-3 we name three roles explicitly, even if a single
person wears multiple hats:

- **Incident Commander** — owns the timeline and final call on actions
- **Communications** — owns external messaging (status page, social, users)
- **Technical Lead** — owns diagnosis and execution of fixes

---

## Containment principles

ArcSwap is a frontend over third-party contracts. Containment options follow
that architecture:

- **Configuration-level**: edge headers and redirects can be reverted in
  seconds without a code push.
- **Build-level**: every deploy is atomically rollback-able to any prior green
  build.
- **Surface-level**: a frontend feature-flag manifest can disable individual
  products (vault deposit / redeem, swap, bridge, pool actions) on demand
  while users keep custody and direct on-chain access.
- **Identity-level**: domain (DNS) and decentralized identity (ENS contenthash)
  are governed by multi-signature wallets — see
  [`docs/GOVERNANCE.md`](GOVERNANCE.md).

**User funds are never under our custody.** If the frontend is paused or
withdrawn entirely, users retain direct on-chain access to their positions
(USYC redeem on Hashnote, USDC withdraw on Circle Gateway, swaps on the
underlying Uniswap V2 contracts, liquidity removal on the same).

---

## Communication

For any SEV-1 or SEV-2, ArcSwap will publish updates in this order and cadence:

1. **Status page** — initial banner within the SLA above
2. **Public channels** ([@arc_swap](https://x.com/arc_swap) on X, Discord) — same content, no DMs (avoids impersonation)
3. **Follow-up updates** — at least every 2 hours until resolution
4. **Resolution notice** — once mitigated, with a one-line root cause
5. **Public post-mortem** — within 7 days, with timeline, root cause, and action items

We do **not** speculate publicly during an incident, and we do **not** request
that users share keys, signatures, or seed phrases under any circumstance. Any
message asking for those, even one that appears to come from us, is fraudulent.

---

## Vendor incidents

If the incident originates in a third-party contract (Hashnote USYC, Circle
CCTP / Gateway, Uniswap V2, Arc L1 itself):

1. We disable the affected surface in the frontend via the kill-switch.
2. We display an advisory banner pointing users to the vendor's official
   communication.
3. We do not duplicate or paraphrase vendor advisories — users are sent to the
   source.

The vendors and their disclosure channels are listed in
[`SECURITY.md`](../SECURITY.md#out-of-scope-third-party--report-to-vendor).

---

## Drills and review

ArcSwap runs internal incident-response drills on a recurring cadence. Each
drill covers one of the threat scenarios in
[`SECURITY_CHECKLIST.md`](../SECURITY_CHECKLIST.md#threat-model)
and updates the internal playbook based on what is learned.

This public policy is reviewed at least once per quarter and after every real
incident.

---

_Last updated: 2026-05-10_
