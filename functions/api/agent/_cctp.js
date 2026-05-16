/**
 * CCTP V2 helpers for agent backend — cross-chain USDC delivery.
 *
 * Architecture:
 *   - Agent's Circle SCA wallet on SOURCE chain calls TokenMessengerV2.depositForBurn
 *     (gas sponsored by Circle Paymaster — no native gas needed).
 *   - Backend polls Circle's IRIS attestation service for the burn message
 *     signature. V2 fast mode finalizes in ~30 seconds.
 *   - Agent's Circle SCA wallet on DEST chain calls MessageTransmitterV2.receiveMessage
 *     to mint native USDC at the recipient address.
 *
 * Why CCTP V2 over a bridge:
 *   - Native burn-and-mint (Circle is the issuer), not a wrapped-asset bridge.
 *   - No third-party trust assumptions.
 *   - Fast mode: ~30s; Standard mode: ~13 min.
 *   - Arc is Circle's own L1, so first-class support.
 *
 * State machine on `agent.pendingCctp[i]`:
 *   circle_initiated → burn_confirmed → attested → mint_initiated → done
 *   (any step can transition to `failed` with `error` set)
 *
 * Driven by handleCronTick — every 5 min the cron advances each pending
 * transfer one step forward (polls Circle for burn hash, polls IRIS for
 * attestation, then submits mint via Circle contractExecution).
 */

import { contractExecution, getTransaction, transferFromUser, CIRCLE_BLOCKCHAIN, CHIP_TO_ARC } from './_circle.js';
import { getUSDCBalance } from './_balance.js';

/* ────────────────────────────────────────────────────────────
   CONSTANTS — mirrored from assets/arc-core.js
   ────────────────────────────────────────────────────────────
   Domain IDs are Circle's canonical chain IDs for CCTP messages
   (NOT the EVM chainId). Source: https://developers.circle.com/stablecoins/cctp-supported-blockchains
   These are stable, public values — safe to commit. */
export const CCTP_DOMAIN = {
  sepolia:         0,
  avalancheFuji:   1,
  optimismSepolia: 2,
  arbitrumSepolia: 3,
  baseSepolia:     6,
  polygonAmoy:     7,
  unichainSepolia: 10,
  arc:             26,
};

// TokenMessengerV2 + MessageTransmitterV2 are deterministically deployed
// via CREATE2 — same address on every supported EVM chain.
// Verified against on-chain at the addresses below (May 2026).
export const TOKEN_MESSENGER_V2     = '0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA';
export const MESSAGE_TRANSMITTER_V2 = '0xE737e5cEBEEBa77EFE34D4aa090756590b1CE275';

// Circle IRIS API — attestation service that signs burn messages so the
// destination chain can verify them. Sandbox endpoint for testnet.
export const IRIS_BASE = 'https://iris-api-sandbox.circle.com/v2';

/* ────────────────────────────────────────────────────────────
   AMOUNT CONVERSION
   ────────────────────────────────────────────────────────────
   We pass USDC amounts to the Circle SCA wallet via the ERC-20 interface
   (`USDC.transferFrom`, `USDC.approve`, `TokenMessenger.depositForBurn`).
   On Arc, the native gas ledger stores balances at 18 decimals (like wei),
   BUT the ERC-20 interface at 0x3600… exposes 6-decimal logical units so
   it's drop-in compatible with standard USDC. Source: arc-core.js + the
   _circle.js Arc USDC comment.

   That means for ALL chains in this codebase, the ERC-20 interface uses 6
   decimals — we don't need per-chain conversion at the ERC-20 boundary.
   Conversion only matters if we were calling the native Arc balance API,
   which we're not. */

/** Human "10.5" USDC → raw BigInt in 6-decimal units (ERC-20 interface). */
export function humanToChainUnits(human, _chainKey) {
  const s = String(human);
  const [whole, frac = ''] = s.split('.');
  const fracPad = (frac + '000000').slice(0, 6);
  return BigInt(whole || '0') * 1000000n + BigInt(fracPad || '0');
}

/** Raw 6-decimal units → CCTP canonical 6-decimal units. Pass-through. */
export function toCctpAmount(rawAmount, _chainKey) {
  return rawAmount;
}

/* ────────────────────────────────────────────────────────────
   ADDRESS ENCODING
   ────────────────────────────────────────────────────────────
   CCTP uses bytes32 for cross-chain recipients (to accommodate non-EVM
   chains). For EVM-to-EVM transfers we left-pad the 20-byte address
   with 12 zero bytes. */
export function addressToBytes32(addr) {
  const clean = String(addr || '').toLowerCase().replace(/^0x/, '');
  if (clean.length !== 40) throw new Error(`addressToBytes32: bad address "${addr}"`);
  return '0x' + '0'.repeat(24) + clean;
}

/* ────────────────────────────────────────────────────────────
   PHASE 1: BURN ON SOURCE CHAIN
   ────────────────────────────────────────────────────────────
   Called when an agent fires a cross-chain transfer. Returns Circle's
   internal tx id; the on-chain hash isn't available immediately (Circle
   batches submissions). The caller persists circleTxId and lets the cron
   discover the txHash later via getTransaction(). */

/**
 * Call TokenMessengerV2.depositForBurn from the agent's source-chain SCA
 * wallet. Burns `amountCctp` units of USDC on source chain; emits a CCTP
 * message that IRIS will attest, which the dest-chain wallet can then
 * use to mint matching USDC at `recipient`.
 *
 * Caller must have already moved USDC into the source SCA wallet (via
 * the permit/transferFrom flow). We do NOT call permit here.
 *
 * @param env Cloudflare Pages env (Circle creds)
 * @param wallet { walletId, source } — agent's SCA wallet on the source chain
 * @param srcChainKey 'baseSepolia' | 'arc' | ...
 * @param destChainKey 'arc' | 'baseSepolia' | ...
 * @param amountCctp BigInt — amount in CCTP 6-decimal units
 * @param recipient 0x...40-hex address on dest chain
 * @param fastMode  true → ~30s finality with tiny fee; false → ~13 min, no fee
 */
export async function depositForBurn(env, wallet, srcChainKey, destChainKey, amountCctp, recipient, fastMode = true) {
  const destDomain = CCTP_DOMAIN[destChainKey];
  if (destDomain == null) throw new Error(`CCTP: unsupported dest chain "${destChainKey}"`);
  const srcDomain = CCTP_DOMAIN[srcChainKey];
  const usdcOnSource = USDC_ADDR_BY_CHAIN[srcChainKey];
  if (!usdcOnSource) throw new Error(`CCTP: no USDC address for source "${srcChainKey}"`);

  const mintRecipient32 = addressToBytes32(recipient);
  // destinationCaller=0x00..00 means "anyone can call receiveMessage on dest".
  // We pass our own SCA wallet later, but leaving this open is safer if for
  // some reason we need a fallback claimer.
  const destinationCaller32 = '0x' + '00'.repeat(32);

  // Discover the actual Fast Transfer fee from IRIS. Previously hard-coded
  // maxFee = amount/10000 + 1 (≈ 1bp) which was below Circle's real Fast
  // Transfer fee for most routes — Circle silently fell back to Standard
  // finality (13+ min wait) instead of Fast (~30s). With IRIS-discovered
  // fees we set maxFee correctly so Fast actually fires.
  let maxFee, minFinality;
  if (fastMode) {
    let feeBpsRaw = null;
    try {
      const fees = await fetchIrisFees(srcDomain, destDomain);
      if (Array.isArray(fees)) {
        const fast = fees.find(f => Number(f.finalityThreshold) === 1000);
        if (fast && Number.isFinite(Number(fast.minimumFee))) {
          feeBpsRaw = Number(fast.minimumFee);
        }
      }
    } catch (e) {
      console.warn(`[cctp] fee lookup failed:`, e?.message || e);
    }
    // IRIS sometimes returns fractional basis points (e.g. 1.3 bps for some
    // testnet routes). We MUST ceil to an integer before BigInt() — passing
    // a fractional number to BigInt throws "The number X cannot be
    // converted to a BigInt because it is not an integer", which crashes
    // the state machine in pull_pending → trying to submit burn.
    //
    // Also bound: anything ≥100 bps (1%) is unreasonable and likely a
    // misparse — fall back to default. Anything <0 is also nonsense.
    let feeBps;
    if (feeBpsRaw != null && feeBpsRaw >= 0 && feeBpsRaw < 100) {
      feeBps = Math.ceil(feeBpsRaw);
    } else {
      if (feeBpsRaw != null) {
        console.warn(`[cctp] unexpected minimumFee value ${feeBpsRaw} — using default`);
      }
      feeBps = 14;  // sane default — covers Circle V2 testnet observed in the wild
    }
    const effectiveBps = feeBps + 1; // +1 bps buffer for dynamic fee jitter
    // maxFee in raw 6-decimal USDC units = amount * bps / 10000
    maxFee = (amountCctp * BigInt(effectiveBps)) / 10000n + 1n;
    minFinality = 1000;
    console.log(`[cctp] depositForBurn fastMode: route ${srcChainKey}(${srcDomain})→${destChainKey}(${destDomain}) discoveredFee=${feeBpsRaw ?? 'unknown'}bps effectiveBps=${effectiveBps} maxFee=${maxFee} amountCctp=${amountCctp}`);
  } else {
    maxFee = 0n;
    minFinality = 2000;
    console.log(`[cctp] depositForBurn standardMode: route ${srcChainKey}(${srcDomain})→${destChainKey}(${destDomain}) maxFee=0`);
  }

  return await contractExecution(env, {
    walletId: wallet.walletId,
    contractAddress: TOKEN_MESSENGER_V2,
    abiFunctionSignature: 'depositForBurn(uint256,uint32,bytes32,address,bytes32,uint256,uint32)',
    abiParameters: [
      amountCctp.toString(),
      destDomain,
      mintRecipient32,
      usdcOnSource.toLowerCase(),
      destinationCaller32,
      maxFee.toString(),
      minFinality,
    ],
  });
}

/** USDC contract addresses by ARC canonical chain key. Duplicated from
 *  _circle.js to avoid a circular import (USDC_ADDRESS is also there). */
const USDC_ADDR_BY_CHAIN = {
  sepolia:         '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238',
  baseSepolia:     '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
  arbitrumSepolia: '0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d',
  optimismSepolia: '0x5fd84259d66Cd46123540766Be93DFE6D43130D7',
  polygonAmoy:     '0x41E94Eb019C0762f9Bfcf9Fb1E58725BfB0e7582',
  avalancheFuji:   '0x5425890298aed601595a70AB815c96711a31Bc65',
  unichainSepolia: '0x31d0220469e10c4E71834a79b1f276d740d3768F',
  arc:             '0x3600000000000000000000000000000000000000',
};

/**
 * Approve TokenMessengerV2 to spend the SCA wallet's USDC. Required once
 * per (wallet, source-chain) pair before the first depositForBurn — CCTP
 * uses transferFrom internally to pull burn tokens.
 *
 * We approve a very large amount (effectively unlimited) so subsequent
 * transfers don't need to re-approve. Standard pattern for SCA wallets
 * that own only USDC.
 */
export async function approveTokenMessenger(env, wallet, srcChainKey) {
  const usdc = USDC_ADDR_BY_CHAIN[srcChainKey];
  if (!usdc) throw new Error(`CCTP: no USDC address for "${srcChainKey}"`);
  // 2^96 - 1 ≈ 7.9e28 — far more than any plausible USDC supply.
  const MAX_APPROVE = (2n ** 96n - 1n).toString();
  return await contractExecution(env, {
    walletId: wallet.walletId,
    contractAddress: usdc,
    abiFunctionSignature: 'approve(address,uint256)',
    abiParameters: [TOKEN_MESSENGER_V2.toLowerCase(), MAX_APPROVE],
  });
}

/* ────────────────────────────────────────────────────────────
   PHASE 2: ATTESTATION
   ──────────────────────────────────────────────────────────── */

/**
 * Query Circle's IRIS fee structure for a (src, dest) CCTP V2 route.
 *
 * Returns an array (or null on error) of:
 *   [{ finalityThreshold: 1000|2000, minimumFee: <basis points> }]
 *
 * - finalityThreshold 1000 = Fast Transfer (~30s but needs sufficient maxFee)
 * - finalityThreshold 2000 = Standard Transfer (~13 min hard finality, fee 0)
 *
 * To get a Fast Transfer, your `maxFee` in depositForBurn must be >= the
 * dynamic on-chain fee, which is `amount * minimumFee / 10000`. If we set
 * maxFee too low, Circle's relayer rejects Fast and falls back to Standard,
 * adding ~13 minutes to E2E time. Empirically observed: 16-minute stall
 * on Base Sepolia → Arc Testnet when maxFee was 1 bps but actual was higher.
 */
export async function fetchIrisFees(srcDomain, destDomain) {
  const url = `${IRIS_BASE}/burn/USDC/fees/${srcDomain}/${destDomain}`;
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(5000) });
    if (!r.ok) {
      console.warn(`[cctp] IRIS fees HTTP ${r.status} for ${url}`);
      return null;
    }
    const data = await r.json();
    // Response shape: { data: [{finalityThreshold, minimumFee}, ...] } OR
    // just the array directly depending on API version.
    const arr = Array.isArray(data) ? data : (data?.data || data?.fees || null);
    if (!Array.isArray(arr)) {
      console.warn(`[cctp] IRIS fees unexpected shape:`, JSON.stringify(data).slice(0, 200));
      return null;
    }
    return arr;
  } catch (e) {
    console.warn('[cctp] fetchIrisFees error:', e?.message || e);
    return null;
  }
}

/**
 * Query Circle's IRIS attestation service for a burn message.
 * Returns null while pending; returns `{ message, attestation }` when
 * Circle has signed the message and it's ready to be claimed on dest.
 *
 *   const att = await fetchAttestation(srcDomain, burnTxHash);
 *   if (att) { /* ready to mint *‌/ }
 */
export async function fetchAttestation(srcDomain, burnTxHash) {
  const url = `${IRIS_BASE}/messages/${srcDomain}?transactionHash=${burnTxHash}`;
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(5000) });
    if (!r.ok) {
      console.warn(`[cctp] IRIS HTTP ${r.status} for ${url}`);
      return null;
    }
    const data = await r.json();
    const msg = (data.messages || [])[0];
    if (!msg) {
      // Empty messages array — IRIS hasn't indexed this burn yet, or the
      // burn was never broadcast. Could also mean wrong srcDomain or wrong
      // txHash. Log enough to debug without dumping full body every tick.
      console.log(`[cctp] IRIS no messages yet for srcDomain=${srcDomain} tx=${burnTxHash.slice(0,12)}… (raw: ${JSON.stringify(data).slice(0, 200)})`);
      return null;
    }
    // IRIS uses 'complete' when attestation is signed, 'pending_confirmations'
    // while waiting for source-chain finality. We only proceed on 'complete'
    // AND a real attestation (not the literal string "PENDING").
    if (msg.status === 'complete' && msg.attestation && msg.attestation !== 'PENDING') {
      console.log(`[cctp] IRIS attestation READY for ${burnTxHash.slice(0,12)}… (msg ${msg.message?.length || 0} bytes, att ${msg.attestation?.length || 0} bytes)`);
      return { message: msg.message, attestation: msg.attestation };
    }
    // Surface the exact IRIS state so we can see whether finality is the
    // blocker or there's a status we're not handling. eventNonce + decodedBody
    // help correlate with the source tx if needed.
    console.log(`[cctp] IRIS pending for ${burnTxHash.slice(0,12)}…: status="${msg.status}" attestation=${msg.attestation === 'PENDING' ? 'PENDING' : (msg.attestation ? `(${msg.attestation.length}b)` : 'null')} eventNonce=${msg.eventNonce || '?'} cctpVersion=${msg.cctpVersion || '?'}`);
    return null;
  } catch (e) {
    console.warn('[cctp] fetchAttestation error:', e?.message || e);
    return null;
  }
}

/* ────────────────────────────────────────────────────────────
   PHASE 3: MINT ON DESTINATION CHAIN
   ──────────────────────────────────────────────────────────── */

/**
 * Submit MessageTransmitterV2.receiveMessage on dest chain to claim the
 * burned USDC. Anyone can call this — we use the agent's dest SCA wallet
 * so Circle Paymaster covers the gas (gasless for the user).
 *
 * After this tx confirms, USDC is minted to whatever address was encoded
 * in `mintRecipient` at burn time (i.e. the agent's user-specified target).
 */
export async function receiveMessage(env, wallet, message, attestation) {
  return await contractExecution(env, {
    walletId: wallet.walletId,
    contractAddress: MESSAGE_TRANSMITTER_V2,
    abiFunctionSignature: 'receiveMessage(bytes,bytes)',
    abiParameters: [message, attestation],
  });
}

/* ────────────────────────────────────────────────────────────
   ORCHESTRATION HELPER
   ──────────────────────────────────────────────────────────── */

/**
 * Initiate a cross-chain CCTP transfer.
 *
 * IMPORTANT: caller must have already executed `transferFromUser(user → srcWallet)`
 * BEFORE calling this — the pull's circleTxId goes in `params.pullCircleTxId`
 * so the state machine can verify pull completion before the burn fires.
 *
 * We do NOT submit any Circle ops here — initial state is 'pull_pending'
 * and `advanceCctpState` (cron-driven) takes over:
 *
 *   pull_pending  → burn_pending      (after pull tx COMPLETE on Circle)
 *   burn_pending  → burn_confirmed    (after burn tx COMPLETE + has txHash)
 *   burn_confirmed → attested          (after IRIS attestation ready)
 *   attested      → mint_pending      (after mint tx submitted)
 *   mint_pending  → done              (after mint tx COMPLETE)
 *
 * The old "submit all 3 ops in one shot" approach raced — burn would fire
 * on-chain before pull/approve confirmed → INSUFFICIENT_TOKEN. This split
 * is slower (~5 cron ticks ≈ 15-25 min) but correct: each step waits for
 * its prerequisite to fully confirm before triggering the next.
 *
 * Approve is no longer per-transfer — it's done ONCE at agent provisioning
 * (see preApproveTokenMessenger). The SCA's allowance to TokenMessenger
 * lives forever (max uint96), so subsequent burns just transferFrom against
 * that pre-existing allowance.
 */
export async function initiateCrossChainTransfer(env, params) {
  const {
    srcWallet,
    destWallet,
    srcChainKey,
    destChainKey,
    amountHuman,
    recipient,
    permitCircleTxId,    // Circle txId of the permit submission on srcChain
    pullOwner,           // user wallet — for pull info, set later when pull submits
    fastMode = true,
  } = params;

  const rawSrc = humanToChainUnits(amountHuman, srcChainKey);
  const cctpUnits = toCctpAmount(rawSrc, srcChainKey);

  return {
    // Start at permit_pending — wait for permit Circle tx to COMPLETE on-chain
    // before submitting pull. Without this, run-now-immediately-after-create
    // races: pull's pre-flight simulation finds allowance=0 (permit not yet
    // mined) and Circle returns INSUFFICIENT_TOKEN.
    state: 'permit_pending',
    fastMode,
    srcChainKey,
    destChainKey,
    srcDomain: CCTP_DOMAIN[srcChainKey],
    destDomain: CCTP_DOMAIN[destChainKey],
    srcWalletId: srcWallet.walletId,
    srcWalletAddr: srcWallet.address,
    destWalletId: destWallet.walletId,
    amountHuman: String(amountHuman),
    amountCctp: cctpUnits.toString(),
    recipient: recipient.toLowerCase(),
    pullOwner: pullOwner || null,
    permitCircleTxId: permitCircleTxId || null,
    pullCircleTxId: null,
    burnCircleTxId: null,
    burnTxHash: null,
    attestationMessage: null,
    attestation: null,
    mintCircleTxId: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    error: null,
  };
}

/**
 * One-time max approval at agent provisioning time. After this lands
 * on-chain, any future depositForBurn from the same SCA can transferFrom
 * USDC without needing a fresh approve. Removes one Circle round-trip
 * (and one source of race conditions) from the per-transfer flow.
 *
 * Idempotent: if already approved, the second approve is a wasteful but
 * harmless on-chain tx. We accept that tradeoff to keep provisioning code
 * simple — no need to query allowance first.
 *
 * Fire-and-forget: this returns the Circle txId; caller doesn't need to
 * wait for confirmation. By the time the first transfer runs (could be
 * minutes to days), the approve will long since have confirmed.
 */
export async function preApproveTokenMessenger(env, wallet, srcChainKey) {
  if (!chainSupportsCctp(srcChainKey)) return null;
  try {
    return await approveTokenMessenger(env, wallet, srcChainKey);
  } catch (e) {
    console.warn(`[cctp] pre-approve failed for ${wallet.walletId} on ${srcChainKey}:`, e?.message || e);
    return null;
  }
}

/**
 * Advance one pending CCTP transfer through its state machine. Returns
 * the updated record (mutated in place is fine; we also return for
 * convenience). Called from cron — each tick advances at most one step
 * per pending transfer to keep tick latency low.
 *
 * Returns the same record with `state` possibly bumped + fields filled.
 */
export async function advanceCctpState(env, p) {
  if (p.state === 'done' || p.state === 'failed') return p;
  p.updatedAt = Date.now();

  // Helper: a Circle tx is "complete" when its on-chain effect has landed.
  // Different states use different completion criteria below.
  function isCircleComplete(tx) {
    return tx?.state === 'COMPLETE' || tx?.state === 'CONFIRMED';
  }
  function checkCircleFailure(tx, label) {
    if (!tx) return false;
    if (tx.state === 'FAILED' || tx.state === 'CANCELLED' || tx.errorReason) {
      p.state = 'failed';
      p.error = `${label} ${tx.state || 'failed'}: ${tx.errorReason || tx.errorCode || 'no detail'}`;
      console.warn(`[cctp] ${label} terminal-failure for circleTxId=${tx.id}:`, p.error);
      return true;
    }
    return false;
  }

  // Each iteration tries to advance ONE state. Loop until we either reach
  // a terminal state or hit a wait point (where we need a future tick).
  // Within a single cron invocation we can advance multiple states only if
  // we're transitioning purely off cached info — e.g. burn_confirmed →
  // attested → submit mint can happen in one tick because each just makes
  // one extra subrequest. Submitting a new Circle tx (and then needing its
  // COMPLETE) requires a different tick because Circle tx ~30s to settle.
  let safetyIterations = 0;
  while (safetyIterations++ < 6) {
    const prev = p.state;
    try {
      if (p.state === 'permit_pending') {
        // Wait for the EIP-2612 permit() submission to finalize on-chain
        // before submitting the pull. Without this, pull's pre-flight
        // simulates with allowance=0 and Circle rejects as INSUFFICIENT_TOKEN
        // (because transferFrom would revert).
        if (!p.permitCircleTxId) {
          // Permit was never submitted (legacy agent path, or the agent's
          // permit was signed before this state existed). Best effort: try
          // pull anyway. If allowance happens to be set it'll work.
          console.log(`[cctp] permit_pending: no permitCircleTxId — skipping wait, proceeding to pull`);
          p.state = 'pull_pending';
          // Fall through to pull_pending in next iteration — don't continue
          // because pull_pending submits a new tx, which we want to do
          // immediately (single subrequest cost), then break.
          continue;
        }
        const tx = await getTransaction(env, p.permitCircleTxId);
        console.log(`[cctp] permit_pending check: permitCircleTxId=${p.permitCircleTxId} circleState=${tx?.state || 'null'}`);
        if (checkCircleFailure(tx, 'permit')) break;
        if (!isCircleComplete(tx)) break;
        // Permit confirmed → submit pull now.
        console.log(`[cctp] permit COMPLETE — submitting pull (transferFrom user → SCA)`);
        const pullTx = await transferFromUser(env, {
          wallet: { walletId: p.srcWalletId },
          sourceChain: p.srcChainKey,
          owner: p.pullOwner,
          target: p.srcWalletAddr,
          amount: p.amountHuman,
        });
        p.pullCircleTxId = pullTx?.id || null;
        p.state = 'pull_pending';
        console.log(`[cctp] pull submitted: circleTxId=${p.pullCircleTxId}`);
        break;
      }

      if (p.state === 'pull_pending') {
        // The pull was submitted by the caller before this state was even
        // created. Wait for Circle to COMPLETE it before submitting burn —
        // burning before pull confirms causes INSUFFICIENT_TOKEN since the
        // source SCA hasn't received the user's USDC yet.
        if (!p.pullCircleTxId) {
          p.state = 'failed';
          p.error = 'missing pullCircleTxId';
          break;
        }
        const tx = await getTransaction(env, p.pullCircleTxId);
        console.log(`[cctp] pull_pending check: pullCircleTxId=${p.pullCircleTxId} circleState=${tx?.state || 'null'}`);
        if (checkCircleFailure(tx, 'pull')) break;
        if (!isCircleComplete(tx)) break; // wait for next tick
        // Pull confirmed → submit burn now. Pre-approve was done at create
        // time, so SCA already has unlimited allowance to TokenMessenger.
        console.log(`[cctp] pull COMPLETE — submitting burn`);
        const burnTx = await depositForBurn(
          env,
          { walletId: p.srcWalletId },
          p.srcChainKey,
          p.destChainKey,
          BigInt(p.amountCctp),
          p.recipient,
          p.fastMode,
        );
        p.burnCircleTxId = burnTx?.id || null;
        p.state = 'burn_pending';
        console.log(`[cctp] burn submitted: circleTxId=${p.burnCircleTxId}`);
        break; // burn won't be COMPLETE in same tick
      }

      if (p.state === 'burn_pending') {
        if (!p.burnCircleTxId) {
          p.state = 'failed';
          p.error = 'missing burnCircleTxId';
          break;
        }
        const tx = await getTransaction(env, p.burnCircleTxId);
        console.log(`[cctp] burn_pending check: burnCircleTxId=${p.burnCircleTxId} circleState=${tx?.state || 'null'} txHash=${tx?.txHash || 'none'}`);
        if (checkCircleFailure(tx, 'burn')) break;
        if (!isCircleComplete(tx) || !tx.txHash) break;
        p.burnTxHash = tx.txHash;
        p.state = 'burn_confirmed';
        console.log(`[cctp] burn confirmed on-chain: ${tx.txHash}`);
        continue; // can immediately try IRIS in same tick (1 fetch is cheap)
      }

      if (p.state === 'burn_confirmed') {
        const att = await fetchAttestation(p.srcDomain, p.burnTxHash);
        console.log(`[cctp] burn_confirmed check: srcDomain=${p.srcDomain} burnHash=${p.burnTxHash} attestation=${att ? 'READY' : 'pending'}`);
        if (att) {
          p.attestationMessage = att.message;
          p.attestation = att.attestation;
          p.state = 'attested';
          continue; // can submit mint right away
        }
        // FALLBACK: if we've been stuck waiting for attestation for >5 min,
        // check the dest chain directly. Circle runs an auto-relayer on
        // testnet that can claim Fast Transfers without us calling
        // receiveMessage ourselves — IRIS public API still reports
        // "pending_confirmations" because it's keyed on the original
        // attestation, but the on-chain mint already happened. Detect by
        // comparing the recipient's USDC balance to a baseline captured
        // right after burn.
        const stuckMs = Date.now() - (p.createdAt || Date.now());
        if (stuckMs > 5 * 60 * 1000) {
          try {
            if (p.preMintBalance == null) {
              // First-time we hit the fallback: capture the current
              // balance as baseline. We can't know what the balance was
              // at burn time (we'd have had to query then), so we assume
              // any INCREASE after this point with the right magnitude is
              // our mint. False positive if someone else sends USDC to
              // the same address — caller can manually force-complete in
              // that case.
              const baseline = await getUSDCBalance(env, p.destChainKey, p.recipient);
              if (baseline != null) {
                p.preMintBalance = baseline.toString();
                console.log(`[cctp] dest-chain fallback baseline: recipient=${p.recipient} balance=${baseline}`);
              }
            } else {
              const now = await getUSDCBalance(env, p.destChainKey, p.recipient);
              if (now != null) {
                const baseline = BigInt(p.preMintBalance);
                const delta = now - baseline;
                const expectedCctp = BigInt(p.amountCctp); // 6-decimal
                console.log(`[cctp] dest-chain fallback check: baseline=${baseline} now=${now} delta=${delta} expectedCctp=${expectedCctp}`);
                // Allow small tolerance for CCTP fast-transfer fees (we
                // pass maxFee = amount/10000 + 1).
                if (delta > 0n && delta >= expectedCctp - (expectedCctp / 1000n) - 10n) {
                  p.state = 'done';
                  p.mintDetectedViaBalanceCheck = true;
                  console.log(`[cctp] DONE via dest-chain balance detection (auto-relayer minted) — delta=${delta}`);
                  break;
                }
              }
            }
          } catch (e) {
            console.warn(`[cctp] dest-chain fallback check error: ${e?.message || e}`);
          }
        }
        break;
      }

      if (p.state === 'attested') {
        console.log(`[cctp] attested → submitting mint via dest wallet ${p.destWalletId} on ${p.destChainKey}`);
        const mint = await receiveMessage(
          env,
          { walletId: p.destWalletId },
          p.attestationMessage,
          p.attestation,
        );
        p.mintCircleTxId = mint?.id || null;
        p.state = 'mint_pending';
        console.log(`[cctp] mint submitted: circleTxId=${p.mintCircleTxId}`);
        break;
      }

      if (p.state === 'mint_pending') {
        const tx = await getTransaction(env, p.mintCircleTxId);
        console.log(`[cctp] mint_pending check: mintCircleTxId=${p.mintCircleTxId} circleState=${tx?.state || 'null'}`);
        if (checkCircleFailure(tx, 'mint')) break;
        if (!isCircleComplete(tx)) break;
        p.state = 'done';
        console.log(`[cctp] DONE — $${p.amountHuman} delivered to ${p.recipient} on ${p.destChainKey}`);
        break;
      }

      // Unknown state — defensive guard.
      console.warn(`[cctp] unknown state "${p.state}" — marking failed`);
      p.state = 'failed';
      p.error = `unknown state: ${p.state}`;
      break;
    } catch (e) {
      p.error = String(e?.message || e).slice(0, 300);
      console.warn(`[cctp] advance error on ${p.state}:`, p.error);
      break;
    }

    // Defensive: if state didn't change, break to avoid infinite loop.
    if (p.state === prev) break;
  }

  return p;
}

/* ────────────────────────────────────────────────────────────
   PUBLIC DISCOVERY
   ──────────────────────────────────────────────────────────── */

/** Whether a chain supports CCTP V2 in this codebase. */
export function chainSupportsCctp(arcKey) {
  return CCTP_DOMAIN[arcKey] != null;
}

/** Chip-id → ARC canonical key, with CCTP support check. */
export function arcKeyForChip(chip) {
  return CHIP_TO_ARC[chip] || chip;
}
