/* ArcSwap Circle Gateway client
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
  // DO NOT reorder fields — order is part of the EIP-712 signing hash.
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

  const ZERO_BYTES32 = '0x' + '00'.repeat(32);

  // Circle Gateway enforces a per-intent minimum `maxFee` on /v1/transfer
  // (testnet currently quotes ~0.02385 USDC). Sending maxFee=0 → 400
  // "Insufficient max fee". We set a comfortable floor and add a 1bp
  // proportional component so larger transfers still leave headroom for
  // Circle's relayer to claim a higher fee if it needs to.
  // All values are in canonical 6-decimal USDC units.
  const MAX_FEE_FLOOR = 50_000n;          // 0.05 USDC — well above the ~0.024 minimum
  const MAX_FEE_BPS_DIVISOR = 10_000n;    // 1bp = value / 10000
  function defaultMaxFee(valueCanonical) {
    const proportional = valueCanonical / MAX_FEE_BPS_DIVISOR;
    return proportional > MAX_FEE_FLOOR ? proportional : MAX_FEE_FLOOR;
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
  // throws on strings containing '.' — so we go through ethers.parseUnits which
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
    const tx = await wallet.deposit(tok.address, value);
    onStep(`Mined ${tx.hash.slice(0, 10)}…`);
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
   * Returns { withdrawing, withdrawable, blockReady, currentBlock } — all BigInt.
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
   */
  async function signAndSubmitBurnIntent(burnIntent, opts = {}) {
    if (!ARC.wallet.signer) throw new Error('Connect wallet');
    opts.onStep?.('Sign burn intent in wallet…');
    const signature = await ARC.wallet.signer.signTypedData(EIP712_DOMAIN, EIP712_TYPES, burnIntent);
    opts.onStep?.('Submitting to Gateway API…');
    const body = JSON.stringify([{
      burnIntent: burnIntentToJson(burnIntent),
      signature,
    }]);
    const res = await fetch(`${GW_BASE}/v1/transfer`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    });
    if (!res.ok) {
      const txt = await res.text().catch(() => '');
      throw new Error(`Gateway /v1/transfer ${res.status}: ${txt.slice(0, 300)}`);
    }
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
   * `dstChainKey` is the destination — wallet will switch to it.
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

  /**
   * One-shot end-to-end spend:
   *   build burn intent → sign → submit → mint on destination.
   * `valueCanonical` in 6-decimal BigInt.
   */
  async function spend({ srcChainKey, dstChainKey, recipient, valueCanonical, maxFee, onStep }) {
    // Circle's /v1/transfer rejects maxFee=0 with "Insufficient max fee".
    // Pick a safe default scaled to amount when caller didn't set one.
    const fee = (maxFee == null || maxFee === 0n) ? defaultMaxFee(valueCanonical) : maxFee;
    const intent = buildBurnIntent({ srcChainKey, dstChainKey, recipient, valueCanonical, maxFee: fee });
    const attResp = await signAndSubmitBurnIntent(intent, { onStep });
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
    const totalAvail = available.reduce((acc, s) => acc + (s.canonical || 0n), 0n);
    if (totalAvail < targetCanonical) return null;
    const sorted = [...available]
      .filter(s => s.canonical && s.canonical > 0n && CHAINS_HAS_MINTER(s.chainKey))
      .sort((a, b) => (b.canonical > a.canonical ? 1 : -1));
    const out = [];
    let remaining = targetCanonical;
    for (const s of sorted) {
      if (remaining <= 0n) break;
      const take = s.canonical >= remaining ? remaining : s.canonical;
      out.push({ chainKey: s.chainKey, valueCanonical: take });
      remaining -= take;
    }
    if (remaining > 0n) return null;
    return out;
  }
  // Helper: chain has a GatewayWallet (we can spend FROM it)
  function CHAINS_HAS_MINTER(k) {
    return Boolean(ARC.CHAINS[k]?.contracts?.gatewayWallet);
  }

  /**
   * Multi-source unified spend: burn from N source chains in one transfer
   * to mint a single combined amount on destination.
   *
   * Flow:
   *   1. Build N burn intents (1 per source chain, with that chain's value)
   *   2. Sign each intent via wallet (user signs N times — one per source chain)
   *      — each chain switch is needed because EIP-712 domain includes the
   *        source chainId via `verifyingContract` semantics in some wallets.
   *      Actually the domain is `{name:"GatewayWallet", version:"1"}` only —
   *      no chainId, no verifyingContract — so we can sign all from any chain.
   *   3. POST array of {burnIntent, signature} to /v1/transfer
   *   4. Receive ONE combined attestation
   *   5. Switch to destination chain → call gatewayMint() once
   *
   * `sources`: [{chainKey, valueCanonical}] — produced by pickSources() or hand-picked
   * Returns { intents, attResp, mint }.
   */
  async function multiSpend({ sources, dstChainKey, recipient, maxFee, onStep }) {
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

    // Sign each. EIP-712 domain has no chainId so signature is portable across
    // chains — wallet doesn't need to switch between sigs. User just confirms N
    // times in the same wallet popup queue.
    const signed = [];
    for (let i = 0; i < intents.length; i++) {
      const s = sources[i];
      onStep?.(`Sign ${i + 1}/${intents.length}: ${ARC.CHAINS[s.chainKey].short} → ${ARC.formatAmt(s.valueCanonical, 6, 4)} USDC`);
      const signature = await ARC.wallet.signer.signTypedData(EIP712_DOMAIN, EIP712_TYPES, intents[i]);
      signed.push({ burnIntent: burnIntentToJson(intents[i]), signature });
    }

    onStep?.('Submitting to Gateway API…');
    const res = await fetch(`${GW_BASE}/v1/transfer`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(signed),
    });
    if (!res.ok) {
      const txt = await res.text().catch(() => '');
      throw new Error(`Gateway /v1/transfer ${res.status}: ${txt.slice(0, 300)}`);
    }
    const attResp = await res.json();

    onStep?.(`Mint on ${ARC.CHAINS[dstChainKey].short}…`);
    const mint = await gatewayMint(dstChainKey, attResp.attestation, attResp.signature, { onStep });
    return { intents, attResp, mint, sources };
  }

  // ───────── EXPORTS ─────────
  ARC.gateway = {
    GW_BASE, EIP712_DOMAIN, EIP712_TYPES, CANONICAL_DECIMALS,
    MAX_FEE_FLOOR, defaultMaxFee,
    gatewayChains, chainByDomain, usdcOnChain,
    canonicalToTokenRaw,
    readBalances, readBalanceOnChain,
    deposit, initiateWithdrawal, finalizeWithdrawal,
    getWithdrawalInfo, withdrawalDelay,
    buildBurnIntent, signAndSubmitBurnIntent, gatewayMint, spend,
    pickSources, multiSpend,
  };
})(window);
