/* Oneliq Circle Gateway client
 * Wraps:
 *  - REST `/v1/balances`  → unified read across N chains in one request
 *  - REST `/v1/transfer`  → submit signed BurnIntent → receive attestation
 *  - On-chain `GatewayWallet.deposit / initiateWithdrawal / withdraw / availableBalance`
 *  - On-chain `GatewayMinter.gatewayMint(attestation, signature)` on destination
 *
 * Architecture:
 *   - Reads go through Cloudflare Pages Function /api/gateway-proxy/*  (CORS-safe,
 *     plus future Bearer-token support if Circle requires it).
 *   - Writes (deposit/withdraw/mint) are direct contract calls via signer.
 *   - Burn intent is signed EIP-712 by user's wallet.
 *
 * Requires: arc-core.js (window.ARC) loaded first.
 */
(function (global) {
  'use strict';
  if (!global.ARC) { console.error('[arc-gateway] ARC core not loaded'); return; }
  const ARC = global.ARC;
  const { Contract, getAddress, isAddress, zeroPadValue, hexlify, randomBytes, AbiCoder } = global.ethers;

  // ───────── CONSTANTS ─────────
  // Route through our Pages Function (avoids CORS, allows server-side auth header
  // injection if Circle starts requiring one in the future).
  const GW_BASE = '/api/gateway-proxy';

  // EIP-712 typed-data definition mirrored verbatim from Circle's quickstart.
  // DO NOT reorder fields - order is part of the EIP-712 signing hash.
  const EIP712_DOMAIN = { name: 'GatewayWallet', version: '1' };
  const EIP712_TYPES = {
    TransferSpec: [
      { name: 'version',              type: 'uint32'  },
      { name: 'sourceDomain',         type: 'uint32'  },
      { name: 'destinationDomain',    type: 'uint32'  },
      { name: 'sourceContract',       type: 'bytes32' },
      { name: 'destinationContract',  type: 'bytes32' },
      { name: 'sourceToken',          type: 'bytes32' },
      { name: 'destinationToken',     type: 'bytes32' },
      { name: 'sourceDepositor',      type: 'bytes32' },
      { name: 'destinationRecipient', type: 'bytes32' },
      { name: 'sourceSigner',         type: 'bytes32' },
      { name: 'destinationCaller',    type: 'bytes32' },
      { name: 'value',                type: 'uint256' },
      { name: 'salt',                 type: 'bytes32' },
      { name: 'hookData',             type: 'bytes'   },
    ],
    BurnIntent: [
      { name: 'maxBlockHeight', type: 'uint256'      },
      { name: 'maxFee',         type: 'uint256'      },
      { name: 'spec',           type: 'TransferSpec' },
    ],
  };

  // Circle Gateway lets N burn intents that share the same sourceSigner (always
  // true for us — one user wallet) be packed into a BurnIntentSet and signed
  // with a SINGLE EIP-712 signature (max 16 intents). This collapses a
  // multi-source spend from N wallet popups down to ONE. Verified against the
  // testnet API 2026-06-20: signing { intents: [...] } with these types and
  // POSTing `[{ burnIntentSet: { intents:[...] }, signature }]` is accepted and
  // the one signature verifies for every intent. (The old per-intent loop hit
  // Chrome's transient-activation limit — only the first popup auto-opened;
  // wallets like OKX just badged the rest. A single signature sidesteps that.)
  const EIP712_TYPES_SET = {
    BurnIntentSet: [{ name: 'intents', type: 'BurnIntent[]' }],
    BurnIntent:    EIP712_TYPES.BurnIntent,
    TransferSpec:  EIP712_TYPES.TransferSpec,
  };

  const ZERO_BYTES32 = '0x' + '00'.repeat(32);

  // Circle Gateway enforces a per-intent minimum `maxFee` on /v1/transfer.
  // VERIFIED 2026-06-20 by signing probe burn intents against the testnet API
  // (maxFee=0 → "expected at least X"): the real minimum is a small, flat,
  // value-independent amount that varies by SOURCE chain — observed OP/Polygon
  // 0.0015, Arbitrum/Base 0.01, Avalanche 0.02 USDC (same for value 1/5/100, so
  // NOT proportional). An earlier note here claimed ~1.0 USDC; that was wrong
  // and needlessly stranded ~1.5 USDC of spendable balance per source. We set
  // the floor to 0.05 USDC — 2.5x the highest observed (0.02) for headroom
  // against gas-driven fluctuation — plus a tiny 0.1% proportional hedge for
  // large transfers. NOTE: this is the BURN fee only; gasless (forwarder) adds
  // a SEPARATE ~0.0035 USDC forwardingFee for the destination mint gas.
  //
  // IMPORTANT: GatewayWallet pre-checks `availableBalance ≥ burn + maxFee` per
  // intent, so an over-large maxFee directly starves spendable balance. If
  // Circle ever quotes higher at submit time, signAndSubmitBurnIntent /
  // multiSpend auto-bump +25% and re-sign once — so a lean floor is safe.
  // All values are in canonical 6-decimal USDC units.
  const MAX_FEE_FLOOR = 50_000n;          // 0.05 USDC - clears max observed (0.02) with 2.5x margin
  const MAX_FEE_BPS_DIVISOR = 1_000n;     // 0.1% = value / 1000 (hedge for large transfers)
  // Approximate forwarder (gasless) fee for the SINGLE destination mint, charged
  // SEPARATELY from the per-intent burn fee when useForwarder is on (see the
  // MAX_FEE note: observed ~0.0035 USDC). The EXACT figure is returned by
  // /v1/transfer and surfaced during settleForwarded — this constant only powers
  // the pre-sign UI estimate (estimateSpend) so the user sees the gasless cost
  // before signing rather than after.
  const FORWARDER_FEE_EST = 3_500n;       // 0.0035 USDC canonical (estimate)
  function defaultMaxFee(valueCanonical) {
    const proportional = valueCanonical / MAX_FEE_BPS_DIVISOR;
    return proportional > MAX_FEE_FLOOR ? proportional : MAX_FEE_FLOOR;
  }

  // Maximum amount actually burnable from a source given fee headroom needed.
  // Solves: burn + defaultMaxFee(burn) ≤ canonical, returning the largest burn.
  // Returns 0n when canonical can't even cover the fee floor.
  function maxBurnableFromBalance(canonical) {
    if (canonical <= MAX_FEE_FLOOR) return 0n;
    // Two regimes:
    //  · proportional binding: fee = burn / D → burn = canonical * D / (D+1)
    //  · floor binding:        fee = FLOOR    → burn = canonical - FLOOR
    // Whichever yields a *larger fee* is the actual binding constraint.
    const propBurn = (canonical * MAX_FEE_BPS_DIVISOR) / (MAX_FEE_BPS_DIVISOR + 1n);
    const propFee = propBurn / MAX_FEE_BPS_DIVISOR;
    if (propFee > MAX_FEE_FLOOR) return propBurn;
    return canonical - MAX_FEE_FLOOR;
  }

  // Parse Circle's 400 hint: '...expected at least X, got Y' → BigInt(X canonical)
  function parseRequiredFee(txt) {
    const m = /expected at least ([\d.]+)/i.exec(txt || '');
    if (!m) return null;
    try { return ARC.parseAmt(m[1], CANONICAL_DECIMALS); } catch { return null; }
  }

  // ───────── HELPERS ─────────
  // `balance` from REST is a decimal string in 6-decimal canonical USDC units.
  // To compare/show against Arc's 18-decimal native USDC we always work in
  // canonical 6-decimal BigInt (the Gateway protocol uses 6 internally).
  const CANONICAL_DECIMALS = 6;

  function gatewayChains() { return ARC.gatewayChains(); }

  function chainByDomain(domain) {
    for (const [k, c] of Object.entries(ARC.CHAINS)) {
      if (Number(c.cctpDomain) === Number(domain) && c.contracts?.gatewayWallet) return k;
    }
    return null;
  }

  function usdcOnChain(chainKey) {
    const t = ARC.TOKENS[chainKey]?.USDC;
    if (!t) throw new Error(`No USDC defined on chain ${chainKey}`);
    return t;
  }

  // Normalize REST balance string → canonical 6-decimal BigInt.
  // Circle's API returns decimals as "10.000000" (NOT "10000000"). Plain BigInt()
  // throws on strings containing '.' - so we go through ethers.parseUnits which
  // handles both decimal-formatted and integer-formatted strings cleanly.
  function balToCanonical(balStr) {
    if (balStr == null || balStr === '' || balStr === '0') return 0n;
    const s = String(balStr).trim();
    try {
      if (s.includes('.') || s.includes('e') || s.includes('E')) {
        return ARC.parseAmt(s, CANONICAL_DECIMALS);
      }
      return BigInt(s);
    } catch { return 0n; }
  }

  // For display: scale canonical 6-decimal balance to a chain's native USDC decimals
  // (no-op for 6, ×10^12 for Arc 18-decimal).
  function canonicalToTokenRaw(canonical, token) {
    const td = token.decimals;
    if (td === CANONICAL_DECIMALS) return canonical;
    if (td > CANONICAL_DECIMALS) return canonical * (10n ** BigInt(td - CANONICAL_DECIMALS));
    return canonical / (10n ** BigInt(CANONICAL_DECIMALS - td));
  }

  // ───────── REST: BALANCES ─────────
  /**
   * Read unified USDC balance across multiple chains in ONE round-trip.
   * @param {string} addr  EVM address to read
   * @param {string[]} [chainKeys]  optional subset; defaults to all gateway chains
   * @returns {Promise<{token:string, balances:Array<{chainKey,domain,canonical:bigint,display:string}>}>}
   */
  async function readBalances(addr, chainKeys) {
    if (!isAddress(addr)) throw new Error('Bad address');
    const chains = (chainKeys || gatewayChains()).filter(k => ARC.CHAINS[k]?.contracts?.gatewayWallet);
    const sources = chains.map(k => ({
      domain: ARC.CHAINS[k].cctpDomain,
      depositor: getAddress(addr),
    }));
    const body = { token: 'USDC', sources };
    const res = await fetch(`${GW_BASE}/v1/balances`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const txt = await res.text().catch(() => '');
      throw new Error(`Gateway /v1/balances ${res.status}: ${txt.slice(0, 200)}`);
    }
    const j = await res.json();
    const balances = (j.balances || []).map(b => {
      const ck = chainByDomain(b.domain);
      const canonical = balToCanonical(b.balance);
      const pending = balToCanonical(b.pendingBatch);
      const tok = ck ? usdcOnChain(ck) : null;
      const raw = tok ? canonicalToTokenRaw(canonical, tok) : canonical;
      const display = ARC.formatAmt(raw, tok?.decimals || CANONICAL_DECIMALS, 4);
      const pendingDisplay = pending > 0n
        ? ARC.formatAmt(canonicalToTokenRaw(pending, tok || { decimals: CANONICAL_DECIMALS }), tok?.decimals || CANONICAL_DECIMALS, 4)
        : '0';
      return { chainKey: ck, domain: b.domain, canonical, pending, raw, display, pendingDisplay, depositor: b.depositor };
    });
    return { token: j.token || 'USDC', balances };
  }

  /**
   * Direct on-chain fallback in case REST is unavailable.
   */
  async function readBalanceOnChain(chainKey, addr) {
    const c = ARC.CHAINS[chainKey];
    if (!c?.contracts?.gatewayWallet) throw new Error(`No gateway on ${chainKey}`);
    const tok = usdcOnChain(chainKey);
    const wallet = new Contract(c.contracts.gatewayWallet, ARC.ABIS.gatewayWallet, ARC.rpcProvider(chainKey));
    return await wallet.availableBalance(tok.address, getAddress(addr));
  }

  // ───────── DEPOSIT / WITHDRAW (on-chain) ─────────
  /**
   * Deposit USDC into GatewayWallet on a given chain.
   * Switches network if needed, approves, deposits.
   * `value` is in chain-native token decimals (6 normally, 18 on Arc).
   */
  async function deposit(chainKey, value, opts = {}) {
    if (!ARC.wallet.address) throw new Error('Connect wallet first');
    await ARC.wallet.ensureChain(chainKey);
    const c = ARC.CHAINS[chainKey];
    const tok = usdcOnChain(chainKey);
    const onStep = opts.onStep || (() => {});
    // Approve
    await ARC.ensureAllowance(chainKey, tok, c.contracts.gatewayWallet, value, onStep);
    onStep('Submitting deposit…');
    const wallet = new Contract(c.contracts.gatewayWallet, ARC.ABIS.gatewayWallet, ARC.wallet.signer);
    // Explicit gasLimit so OP-Stack testnets (OP Sepolia, Unichain Sepolia) don't
    // reject the wallet's auto-estimate with "intrinsic gas too high".
    const ov = await ARC.gasOverrides(chainKey, c.contracts.gatewayWallet, ARC.ABIS.gatewayWallet, 'deposit', [tok.address, value], 300_000n);
    const tx = await wallet.deposit(tok.address, value, ov);
    onStep(`Submitted ${tx.hash.slice(0, 10)}…`);
    const receipt = await tx.wait();
    return { tx, receipt };
  }

  /**
   * 2-step withdraw: initiate → wait `withdrawalDelay()` → withdraw.
   * Returns the tx + receipt of the initiation. Caller polls `getWithdrawals()`.
   */
  async function initiateWithdrawal(chainKey, value, opts = {}) {
    if (!ARC.wallet.address) throw new Error('Connect wallet first');
    await ARC.wallet.ensureChain(chainKey);
    const c = ARC.CHAINS[chainKey];
    const tok = usdcOnChain(chainKey);
    opts.onStep?.('Initiating withdrawal…');
    const wallet = new Contract(c.contracts.gatewayWallet, ARC.ABIS.gatewayWallet, ARC.wallet.signer);
    const tx = await wallet.initiateWithdrawal(tok.address, value);
    return { tx, receipt: await tx.wait() };
  }

  async function finalizeWithdrawal(chainKey, opts = {}) {
    if (!ARC.wallet.address) throw new Error('Connect wallet first');
    await ARC.wallet.ensureChain(chainKey);
    const c = ARC.CHAINS[chainKey];
    const tok = usdcOnChain(chainKey);
    opts.onStep?.('Finalizing withdrawal…');
    const wallet = new Contract(c.contracts.gatewayWallet, ARC.ABIS.gatewayWallet, ARC.wallet.signer);
    const tx = await wallet.withdraw(tok.address);
    return { tx, receipt: await tx.wait() };
  }

  /**
   * On-chain pending withdrawal info for one chain.
   * Returns { withdrawing, withdrawable, blockReady, currentBlock } - all BigInt.
   *  - withdrawing: total amount initiated but not yet finalized
   *  - withdrawable: amount currently claimable (0 if delay not elapsed)
   *  - blockReady: block number when the withdrawal becomes finalizable
   */
  async function getWithdrawalInfo(chainKey, addr) {
    const c = ARC.CHAINS[chainKey];
    const tok = usdcOnChain(chainKey);
    const wallet = new Contract(c.contracts.gatewayWallet, ARC.ABIS.gatewayWallet, ARC.rpcProvider(chainKey));
    const [withdrawing, withdrawable, blockReady, currentBlock] = await Promise.all([
      wallet.withdrawingBalance(tok.address, getAddress(addr)).catch(() => 0n),
      wallet.withdrawableBalance(tok.address, getAddress(addr)).catch(() => 0n),
      wallet.withdrawalBlock(tok.address, getAddress(addr)).catch(() => 0n),
      ARC.rpcProvider(chainKey).getBlockNumber().catch(() => 0),
    ]);
    return { withdrawing, withdrawable, blockReady, currentBlock: BigInt(currentBlock) };
  }

  async function withdrawalDelay(chainKey) {
    const c = ARC.CHAINS[chainKey];
    const wallet = new Contract(c.contracts.gatewayWallet, ARC.ABIS.gatewayWallet, ARC.rpcProvider(chainKey));
    return await wallet.withdrawalDelay();
  }

  // ───────── SPEND: Build / Sign / Submit / Mint ─────────

  /**
   * Build a BurnIntent for cross-chain spending.
   * `value` is canonical 6-decimal (uint256).
   * `recipient` is on `dstChainKey`.
   */
  function buildBurnIntent({ srcChainKey, dstChainKey, recipient, valueCanonical, maxFee = 0n, maxBlockHeight }) {
    const src = ARC.CHAINS[srcChainKey];
    const dst = ARC.CHAINS[dstChainKey];
    if (!src?.contracts?.gatewayWallet) throw new Error(`No gateway on ${srcChainKey}`);
    if (!dst?.contracts?.gatewayMinter) throw new Error(`No gateway on ${dstChainKey}`);
    const srcTok = usdcOnChain(srcChainKey);
    const dstTok = usdcOnChain(dstChainKey);
    const signer = ARC.wallet.address;
    if (!signer) throw new Error('Connect wallet');
    const spec = {
      version: 1,
      sourceDomain: src.cctpDomain,
      destinationDomain: dst.cctpDomain,
      sourceContract: ARC.addrToBytes32(src.contracts.gatewayWallet),
      destinationContract: ARC.addrToBytes32(dst.contracts.gatewayMinter),
      sourceToken: ARC.addrToBytes32(srcTok.address),
      destinationToken: ARC.addrToBytes32(dstTok.address),
      sourceDepositor: ARC.addrToBytes32(signer),
      destinationRecipient: ARC.addrToBytes32(recipient || signer),
      sourceSigner: ARC.addrToBytes32(signer),
      destinationCaller: ZERO_BYTES32, // anyone can submit gatewayMint (no whitelisting)
      value: valueCanonical,
      salt: hexlify(randomBytes(32)),
      hookData: '0x',
    };
    return {
      maxBlockHeight: maxBlockHeight ?? ((1n << 256n) - 1n), // no expiry by default
      maxFee,
      spec,
    };
  }

  /**
   * Sign + submit burn intent → returns { attestation, signature, transferId, fees }.
   * On success the destination chain has a ready-to-mint payload.
   *
   * Resilience: if Circle returns 400 "Insufficient max fee: expected at
   * least X" we parse X, bump the intent's maxFee above it, re-sign once,
   * and retry. This costs the user one extra signature in the rare case
   * Circle's quote moves between our default and submission time.
   */
  async function signAndSubmitBurnIntent(burnIntent, opts = {}) {
    if (!ARC.wallet.signer) throw new Error('Connect wallet');
    const submit = async (intent, label) => {
      opts.onStep?.(label);
      const signature = await ARC.wallet.signer.signTypedData(EIP712_DOMAIN, EIP712_TYPES, intent);
      opts.onStep?.('Submitting to Gateway API…');
      const res = await fetch(`${GW_BASE}/v1/transfer${opts.useForwarder ? '?enableForwarder=true' : ''}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify([{ burnIntent: burnIntentToJson(intent), signature }]),
      });
      const txt = res.ok ? null : await res.text().catch(() => '');
      return { res, txt };
    };
    let { res, txt } = await submit(burnIntent, 'Sign burn intent in wallet…');
    if (!res.ok && res.status === 400) {
      const required = parseRequiredFee(txt);
      if (required && required > burnIntent.maxFee) {
        // Bump well above the quoted minimum (+25%) so a tiny rate change
        // mid-flight doesn't trip the same error a second time.
        burnIntent.maxFee = required + (required / 4n);
        opts.onStep?.(`Fee bumped to ${ARC.formatAmt(burnIntent.maxFee, CANONICAL_DECIMALS, 4)} USDC. Please re-sign.`);
        ({ res, txt } = await submit(burnIntent, 'Re-sign with bumped fee…'));
      }
    }
    if (!res.ok) throw new Error(`Gateway /v1/transfer ${res.status}: ${(txt || '').slice(0, 300)}`);
    return await res.json();
  }

  // BigInt → string for JSON; bytes already hex.
  function burnIntentToJson(bi) {
    return {
      maxBlockHeight: bi.maxBlockHeight.toString(),
      maxFee: bi.maxFee.toString(),
      spec: {
        ...bi.spec,
        value: bi.spec.value.toString(),
      },
    };
  }

  /**
   * Mint USDC on destination chain using attestation from /v1/transfer.
   * `dstChainKey` is the destination - wallet will switch to it.
   */
  async function gatewayMint(dstChainKey, attestation, signature, opts = {}) {
    if (!ARC.wallet.signer) throw new Error('Connect wallet');
    await ARC.wallet.ensureChain(dstChainKey);
    const c = ARC.CHAINS[dstChainKey];
    if (!c?.contracts?.gatewayMinter) throw new Error(`No minter on ${dstChainKey}`);
    opts.onStep?.('Minting on destination…');
    const minter = new Contract(c.contracts.gatewayMinter, ARC.ABIS.gatewayMinter, ARC.wallet.signer);
    const tx = await minter.gatewayMint(attestation, signature);
    return { tx, receipt: await tx.wait() };
  }

  // ───────── FORWARDER (gasless destination mint) ─────────
  /**
   * Poll a forwarded transfer until Circle's Forwarding Service has submitted
   * the destination mint. Used only when /v1/transfer was called with
   * `?enableForwarder=true` (which returns a `transferId`).
   *
   * Status lifecycle (GET /v1/transfer/{id}.status):
   *   pending → confirmed → finalized   (mint landed on destination)
   *   failed | expired                  (terminal failure)
   * Returns the transfer-details object (incl. `transactionHash` of the mint)
   * on confirmed/finalized; throws on failed/expired; throws a tagged
   * `stillPending` error on timeout (mint may yet land - do NOT auto-retry mint).
   */
  async function pollTransfer(transferId, opts = {}) {
    const intervalMs = opts.intervalMs || 3000;
    const timeoutMs = opts.timeoutMs || 180000;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      let details = null;
      const res = await fetch(`${GW_BASE}/v1/transfer/${transferId}`, {
        headers: { 'Accept': 'application/json' },
      }).catch(() => null);
      if (res && res.ok) {
        details = await res.json().catch(() => null);
        const status = String(details?.status || '').toLowerCase();
        if (status === 'confirmed' || status === 'finalized') return details;
        if (status === 'failed' || status === 'expired') {
          const te = new Error(`Forwarded transfer ${status}${details?.transactionHash ? ` (tx ${details.transactionHash})` : ''}`);
          te.terminal = true; // distinguishes "dead" from "still pending" for resume logic
          throw te;
        }
        opts.onStep?.(`Forwarder minting… (${status || 'pending'})`);
      }
      await new Promise(r => setTimeout(r, intervalMs));
    }
    const e = new Error(`Forwarder still processing after ${Math.round(timeoutMs / 1000)}s — transferId ${transferId}`);
    e.transferId = transferId;
    e.stillPending = true;
    throw e;
  }

  // Surface the forwarder fee (if any) then wait for the gasless mint to land.
  // `attResp` is the /v1/transfer response (carries transferId + fees, and still
  // attestation+signature should a caller want to self-mint as a fallback).
  async function awaitForwarded(attResp, dstChainKey, opts = {}) {
    const ff = attResp?.fees?.forwardingFee;
    const dstName = ARC.CHAINS[dstChainKey]?.short || dstChainKey;
    if (ff) {
      opts.onStep?.(`Forwarder minting on ${dstName} (fee ${ARC.formatAmt(balToCanonical(ff), CANONICAL_DECIMALS, 4)} USDC)…`);
    } else {
      opts.onStep?.(`Forwarder minting on ${dstName}…`);
    }
    return await pollTransfer(attResp.transferId, { onStep: opts.onStep });
  }

  // ───────── RESUMABLE PENDING TRANSFERS (survive page reload) ─────────
  // Circle's forwarder usually lands the destination mint server-side even if
  // the user closes the tab. But our in-RAM attestation+signature safety-net
  // (used to self-mint if the forwarder stalls) is lost on reload. So we mirror
  // each in-flight forwarded transfer to localStorage; on next load
  // resumePending() can re-check status and, if still unminted, self-mint.
  const PENDING_KEY = 'arc.gw.pending.v1';
  function loadPending() {
    try { const r = localStorage.getItem(PENDING_KEY); return r ? JSON.parse(r) : []; }
    catch { return []; }
  }
  function savePending(list) {
    try {
      if (!list || !list.length) localStorage.removeItem(PENDING_KEY);
      else localStorage.setItem(PENDING_KEY, JSON.stringify(list.slice(-10))); // cap to last 10
    } catch {}
  }
  function rememberPending(rec) {
    if (!rec || !rec.transferId) return;
    const list = loadPending().filter(p => p.transferId !== rec.transferId);
    list.push(rec);
    savePending(list);
  }
  function forgetPending(transferId) {
    if (!transferId) return;
    savePending(loadPending().filter(p => p.transferId !== transferId));
  }

  /**
   * Wait for the forwarder to land the mint, with a self-mint safety net.
   * If forwarding fails/times out we still hold attestation+signature, so we
   * self-mint (needs destination gas). gatewayMint reverts on an already-used
   * attestation, so if that revert happens it usually means the forwarder DID
   * land the mint and our poll just missed it - we re-check status before
   * surfacing an error. Returns a shape compatible with the self-mint path
   * (`mint.tx.hash`) so callers/UI don't branch.
   *
   * Persistence: we mirror the in-flight transfer to localStorage on entry and
   * clear it on success or terminal failure (failed/expired). A non-terminal
   * throw (forwarder still pending, or self-mint failed for lack of gas) leaves
   * the record in place so resumePending() can recover it after a reload.
   * `opts.recipient` / `opts.valueCanonical` are stored only for nicer UI on resume.
   */
  async function settleForwarded(attResp, dstChainKey, opts = {}) {
    const rec = attResp.transferId ? {
      transferId: attResp.transferId,
      attestation: attResp.attestation || null,
      signature:   attResp.signature || null,
      dstChainKey,
      address:   (ARC.wallet.address || '').toLowerCase() || null,
      recipient: opts.recipient || null,
      amount:    (opts.valueCanonical != null) ? opts.valueCanonical.toString() : null,
      createdAt: Date.now(),
    } : null;
    if (rec) rememberPending(rec);
    const done = (val) => { if (rec) forgetPending(rec.transferId); return val; };
    try {
      const forwarded = await awaitForwarded(attResp, dstChainKey, opts);
      return done({ forwarded, mint: { tx: { hash: forwarded.transactionHash } } });
    } catch (fwdErr) {
      if (fwdErr.terminal) { if (rec) forgetPending(rec.transferId); throw fwdErr; }
      if (!attResp.attestation || !attResp.signature) throw fwdErr; // keep record → resume later
      opts.onStep?.('Forwarder did not complete — minting yourself (needs destination gas)…');
      try {
        const mint = await gatewayMint(dstChainKey, attResp.attestation, attResp.signature, { onStep: opts.onStep });
        return done({ mint, forwardFallback: true });
      } catch (mintErr) {
        const ok = await pollTransfer(attResp.transferId, { onStep: opts.onStep, timeoutMs: 8000, intervalMs: 2000 }).catch(() => null);
        if (ok) return done({ forwarded: ok, mint: { tx: { hash: ok.transactionHash } } });
        throw mintErr; // keep record so the user can resume self-mint after topping up gas
      }
    }
  }

  /**
   * Recover forwarded transfers persisted from a previous page session.
   * For each stored record: re-check Gateway status first (the forwarder may
   * have landed the mint while the user was away → just clear it); otherwise,
   * if we still hold attestation+signature, run settleForwarded to finish it
   * (forwarder-await → self-mint fallback). Terminal/finished records are
   * dropped; genuinely-stuck ones (e.g. user still has no destination gas) are
   * left in place to retry next load. Only the connected wallet's own records
   * are resumed. Returns an array of {transferId, status, txHash?}.
   *
   * `opts.onResolved(rec)` fires per record that completes (status
   * confirmed|finalized|resumed) or terminates (failed|expired) — handy for UI
   * to refresh balances / append history.
   */
  async function resumePending(opts = {}) {
    const addr = (ARC.wallet.address || '').toLowerCase();
    const list = loadPending();
    if (!list.length) return [];
    const results = [];
    for (const rec of list) {
      if (addr && rec.address && rec.address !== addr) continue; // not this wallet's transfer
      let details = null;
      try {
        const res = await fetch(`${GW_BASE}/v1/transfer/${rec.transferId}`, { headers: { Accept: 'application/json' } });
        if (res && res.ok) details = await res.json().catch(() => null);
      } catch {}
      const status = String(details?.status || '').toLowerCase();
      if (status === 'confirmed' || status === 'finalized') {
        forgetPending(rec.transferId);
        const out = { transferId: rec.transferId, status, txHash: details?.transactionHash || null, dstChainKey: rec.dstChainKey, amount: rec.amount, recipient: rec.recipient };
        results.push(out); opts.onResolved?.(out);
        continue;
      }
      if (status === 'failed' || status === 'expired') {
        forgetPending(rec.transferId);
        const out = { transferId: rec.transferId, status, dstChainKey: rec.dstChainKey };
        results.push(out); opts.onResolved?.(out);
        continue;
      }
      // Still pending/unknown — resume only if we kept attestation+signature.
      if (rec.attestation && rec.signature) {
        try {
          const settled = await settleForwarded(
            { transferId: rec.transferId, attestation: rec.attestation, signature: rec.signature },
            rec.dstChainKey,
            { onStep: opts.onStep, recipient: rec.recipient, valueCanonical: rec.amount != null ? BigInt(rec.amount) : undefined }
          );
          const txHash = settled?.mint?.tx?.hash || settled?.forwarded?.transactionHash || null;
          const out = { transferId: rec.transferId, status: 'resumed', txHash, dstChainKey: rec.dstChainKey, amount: rec.amount, recipient: rec.recipient };
          results.push(out); opts.onResolved?.(out);
        } catch (e) {
          results.push({ transferId: rec.transferId, status: 'pending', error: (ARC.explainError ? ARC.explainError(e) : String(e)) });
        }
      }
    }
    return results;
  }

  /**
   * One-shot end-to-end spend:
   *   build burn intent → sign → submit → mint on destination.
   * `valueCanonical` in 6-decimal BigInt.
   */
  async function spend({ srcChainKey, dstChainKey, recipient, valueCanonical, maxFee, onStep, useForwarder }) {
    if (!ARC.wallet.signer) throw new Error('Connect wallet');
    // SECURITY: defense-in-depth chain verification. Callers in trade.html
    // already call ensureChain before us, but if a future caller forgets,
    // signing on the wrong chain could let an attacker exploit the fact
    // that Circle's GatewayWallet EIP-712 domain lacks chainId (signature
    // is portable). Forcing ensureChain here also prompts MetaMask to
    // surface the chain switch to the user.
    await ARC.wallet.ensureChain(srcChainKey);
    // Circle's /v1/transfer rejects maxFee=0 with "Insufficient max fee".
    // Pick a safe default scaled to amount when caller didn't set one.
    const fee = (maxFee == null || maxFee === 0n) ? defaultMaxFee(valueCanonical) : maxFee;
    const intent = buildBurnIntent({ srcChainKey, dstChainKey, recipient, valueCanonical, maxFee: fee });
    const attResp = await signAndSubmitBurnIntent(intent, { onStep, useForwarder });
    if (useForwarder && attResp.transferId) {
      const settled = await settleForwarded(attResp, dstChainKey, { onStep, recipient: recipient || ARC.wallet.address, valueCanonical });
      return { intent, attResp, ...settled };
    }
    const mint = await gatewayMint(dstChainKey, attResp.attestation, attResp.signature, { onStep });
    return { intent, attResp, mint };
  }

  /**
   * Greedy source selection for multi-chain spend.
   * Given a target amount (canonical 6-decimal BigInt) and an array of
   * `{chainKey, canonical}` entries (each chain's available Gateway balance),
   * returns the minimum set of sources that cover the target amount.
   *
   * Strategy: sort descending by balance → consume largest first → fall through
   * to smaller chains. Last chain may be partially used (just enough to fill).
   *
   * Returns [{chainKey, valueCanonical}] in spend order, or null if total
   * available is less than the requested amount.
   */
  function pickSources(targetCanonical, available) {
    if (targetCanonical <= 0n) return [];
    // Fee-aware: each source's effective burnable = canonical - maxFee headroom.
    // Sources where canonical ≤ FLOOR contribute 0 (fee alone exceeds balance).
    const sorted = [...available]
      .filter(s => s.canonical && s.canonical > 0n && CHAINS_HAS_MINTER(s.chainKey))
      .map(s => ({ ...s, burnable: maxBurnableFromBalance(s.canonical) }))
      .filter(s => s.burnable > 0n)
      .sort((a, b) => (b.burnable > a.burnable ? 1 : -1));
    const totalBurnable = sorted.reduce((acc, s) => acc + s.burnable, 0n);
    if (totalBurnable < targetCanonical) return null;
    const out = [];
    let remaining = targetCanonical;
    for (const s of sorted) {
      if (remaining <= 0n) break;
      const take = s.burnable >= remaining ? remaining : s.burnable;
      out.push({ chainKey: s.chainKey, valueCanonical: take });
      remaining -= take;
    }
    if (remaining > 0n) return null;
    return out;
  }

  // Total spendable across a balance set, after reserving fee headroom on each.
  // Useful for "Available for cross-chain spend" UI that reflects what
  // pickSources will actually be able to allocate.
  function totalSpendable(available) {
    return available
      .filter(s => CHAINS_HAS_MINTER(s.chainKey))
      .reduce((acc, s) => acc + maxBurnableFromBalance(s.canonical || 0n), 0n);
  }
  // Helper: chain has a GatewayWallet (we can spend FROM it)
  function CHAINS_HAS_MINTER(k) {
    return Boolean(ARC.CHAINS[k]?.contracts?.gatewayWallet);
  }

  /**
   * Pre-sign spend estimate — the Arc Unified-Balance `estimateSpend` pattern.
   * Given a target amount, destination, and available balances, returns the
   * planned route + fees + recipient-side outcome + forwarding impact BEFORE the
   * user signs (so the wallet popup is never the first time they see the cost,
   * and the reactive per-intent fee re-sign in multiSpend stays a rare safety net
   * rather than the normal path).
   *
   * It also classifies partial liquidity into the three DISCRETE states Arc's
   * "Partial Liquidity, Routing & Fallback" guidance says to surface instead of
   * one generic error:
   *   · 'ok'                   — clean single-source route (the preferred path)
   *   · 'fallback_required'    — a route exists but must aggregate ≥2 sources
   *                              (partial-liquidity fallback, not the single
   *                              preferred route)
   *   · 'no_route'             — enough raw balance exists but none is routable
   *                              (stranded on chains with no GatewayWallet, eaten
   *                              by per-intent fee headroom, or the destination
   *                              has no GatewayMinter to mint into)
   *   · 'insufficient_balance' — total raw balance is below the target
   *
   * @param {bigint} targetCanonical  amount to mint on destination (6-dec canonical)
   * @param {string} dstChainKey      destination chain
   * @param {Array<{chainKey,canonical:bigint}>} available  source balances
   *        (caller should already exclude the destination chain)
   * @param {Array<{chainKey,valueCanonical:bigint}>} [sources]  estimate a
   *        hand-picked allocation instead of auto-picking
   * @param {boolean} [useForwarder]  include the gasless forwarder fee estimate
   * @returns {{ ok, state, reason, sources, sourceCount, burnFee, forwardingFee,
   *             totalFee, netReceived, target, rawTotal, spendable, useForwarder }}
   */
  function estimateSpend({ targetCanonical, dstChainKey, available = [], sources = null, useForwarder = false }) {
    const target = BigInt(targetCanonical || 0n);
    const rawTotal = (available || []).reduce((acc, s) => acc + BigInt(s.canonical || 0n), 0n);
    const spendable = totalSpendable(available || []);
    const dstShort = ARC.CHAINS[dstChainKey]?.short || dstChainKey;
    const base = {
      ok: false, target, rawTotal, spendable, sources: [], sourceCount: 0,
      burnFee: 0n, forwardingFee: 0n, totalFee: 0n, netReceived: 0n, useForwarder: !!useForwarder,
    };

    if (target <= 0n) return { ...base, state: 'insufficient_balance', reason: 'Enter an amount.' };

    // Destination must be able to mint at all — otherwise there is no route no
    // matter how much spendable balance the user holds.
    if (!ARC.CHAINS[dstChainKey]?.contracts?.gatewayMinter) {
      return { ...base, state: 'no_route', reason: `No Gateway minter on ${dstShort} — nothing can be minted there.` };
    }

    const plan = sources || pickSources(target, available || []);
    if (!plan || !plan.length) {
      if (rawTotal < target) {
        return { ...base, state: 'insufficient_balance',
          reason: `Need ${ARC.formatAmt(target, CANONICAL_DECIMALS, 4)} USDC — total balance is ${ARC.formatAmt(rawTotal, CANONICAL_DECIMALS, 4)} USDC.` };
      }
      return { ...base, state: 'no_route',
        reason: `You hold ${ARC.formatAmt(rawTotal, CANONICAL_DECIMALS, 4)} USDC but only ${ARC.formatAmt(spendable, CANONICAL_DECIMALS, 4)} is routable to ${dstShort} (the rest sits on non-spendable chains or is reserved for Circle's per-intent fee).` };
    }

    const burnFee = plan.reduce((acc, p) => acc + defaultMaxFee(p.valueCanonical), 0n);
    const forwardingFee = useForwarder ? FORWARDER_FEE_EST : 0n;
    const state = plan.length >= 2 ? 'fallback_required' : 'ok';
    return {
      ok: true, state,
      reason: state === 'fallback_required'
        ? `No single chain covers this — aggregating ${plan.length} sources (partial-liquidity route).`
        : 'Direct single-source route.',
      target, rawTotal, spendable,
      sources: plan, sourceCount: plan.length,
      burnFee, forwardingFee, totalFee: burnFee + forwardingFee,
      netReceived: target,  // recipient receives the full burn value; fees come from balance on top
      useForwarder: !!useForwarder,
    };
  }

  /**
   * Multi-source unified spend: burn from N source chains in one transfer
   * to mint a single combined amount on destination.
   *
   * Flow:
   *   1. Build N burn intents (1 per source chain, with that chain's value)
   *   2. Sign them with a SINGLE wallet signature via BurnIntentSet (one popup
   *      for the whole spend; N≥2 → set, N==1 → plain burnIntent). The EIP-712
   *      domain is `{name:"GatewayWallet", version:"1"}` (no chainId), so the
   *      one signature is valid for every source regardless of current chain.
   *   3. POST `[{ burnIntentSet:{intents}, signature }]` (or single burnIntent)
   *      to /v1/transfer
   *   4. Receive ONE combined attestation
   *   5. Switch to destination chain → call gatewayMint() once (or forwarder)
   *
   * `sources`: [{chainKey, valueCanonical}] - produced by pickSources() or hand-picked
   * Returns { intents, attResp, mint }.
   */
  async function multiSpend({ sources, dstChainKey, recipient, maxFee, onStep, useForwarder }) {
    if (!ARC.wallet.signer) throw new Error('Connect wallet');
    if (!sources || !sources.length) throw new Error('No sources to spend from');

    onStep?.(`Building ${sources.length} burn intent${sources.length > 1 ? 's' : ''}…`);
    // Per-intent maxFee: each source intent must clear Circle's minimum on its
    // own (the API doesn't sum fees across sources). Scale per source value.
    const intents = sources.map(s => buildBurnIntent({
      srcChainKey: s.chainKey,
      dstChainKey,
      recipient,
      valueCanonical: s.valueCanonical,
      maxFee: (maxFee == null || maxFee === 0n) ? defaultMaxFee(s.valueCanonical) : maxFee,
    }));

    // Sign + submit, with one auto-retry across ALL intents if Circle quotes a
    // higher per-intent minimum than we picked.
    //
    // Multi-source = ONE wallet signature via BurnIntentSet. The old approach
    // signed each intent in its own popup, but Chrome only lets a wallet
    // auto-open one popup per user gesture (transient activation, ~5s) — so
    // after the first signature the gesture had expired and wallets like OKX
    // just badged the queued request instead of surfacing it, forcing the user
    // to click the extension for every source. Packing the intents into a
    // BurnIntentSet (Circle verifies one signature for all of them) collapses
    // the whole spend to a single popup. Single-source keeps the plain
    // burnIntent format (one intent, already one popup).
    const signBundle = async (label) => {
      if (intents.length === 1) {
        onStep?.(`${label} in your wallet…`);
        const signature = await ARC.wallet.signer.signTypedData(EIP712_DOMAIN, EIP712_TYPES, intents[0]);
        return [{ burnIntent: burnIntentToJson(intents[0]), signature }];
      }
      onStep?.(`${label} — one signature covers all ${intents.length} sources…`);
      const signature = await ARC.wallet.signer.signTypedData(EIP712_DOMAIN, EIP712_TYPES_SET, { intents });
      return [{ burnIntentSet: { intents: intents.map(burnIntentToJson) }, signature }];
    };
    const submit = async (signed) => {
      onStep?.('Submitting to Gateway API…');
      const res = await fetch(`${GW_BASE}/v1/transfer${useForwarder ? '?enableForwarder=true' : ''}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(signed),
      });
      const txt = res.ok ? null : await res.text().catch(() => '');
      return { res, txt };
    };
    let signed = await signBundle('Sign burn intent');
    let { res, txt } = await submit(signed);
    if (!res.ok && res.status === 400) {
      const required = parseRequiredFee(txt);
      if (required) {
        const bumped = required + (required / 4n); // +25% headroom
        let bumpedAny = false;
        intents.forEach(it => {
          if (bumped > it.maxFee) { it.maxFee = bumped; bumpedAny = true; }
        });
        if (bumpedAny) {
          onStep?.(`Fee bumped to ${ARC.formatAmt(bumped, CANONICAL_DECIMALS, 4)} USDC per intent. Please re-sign.`);
          signed = await signBundle('Re-sign');
          ({ res, txt } = await submit(signed));
        }
      }
    }
    if (!res.ok) throw new Error(`Gateway /v1/transfer ${res.status}: ${(txt || '').slice(0, 300)}`);
    const attResp = await res.json();

    if (useForwarder && attResp.transferId) {
      const totalValue = sources.reduce((acc, s) => acc + s.valueCanonical, 0n);
      const settled = await settleForwarded(attResp, dstChainKey, { onStep, recipient: recipient || ARC.wallet.address, valueCanonical: totalValue });
      return { intents, attResp, ...settled, sources };
    }
    onStep?.(`Mint on ${ARC.CHAINS[dstChainKey].short}…`);
    const mint = await gatewayMint(dstChainKey, attResp.attestation, attResp.signature, { onStep });
    return { intents, attResp, mint, sources };
  }

  // ───────── EXPORTS ─────────
  ARC.gateway = {
    GW_BASE, EIP712_DOMAIN, EIP712_TYPES, CANONICAL_DECIMALS,
    MAX_FEE_FLOOR, FORWARDER_FEE_EST, defaultMaxFee, maxBurnableFromBalance, totalSpendable,
    estimateSpend,
    gatewayChains, chainByDomain, usdcOnChain,
    canonicalToTokenRaw,
    readBalances, readBalanceOnChain,
    deposit, initiateWithdrawal, finalizeWithdrawal,
    getWithdrawalInfo, withdrawalDelay,
    buildBurnIntent, signAndSubmitBurnIntent, gatewayMint, spend,
    pickSources, multiSpend, pollTransfer,
    resumePending, listPending: loadPending,
  };
})(window);
