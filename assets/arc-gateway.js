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
  function balToCanonical(balStr) {
    try { return BigInt(balStr); } catch { return 0n; }
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
      const tok = ck ? usdcOnChain(ck) : null;
      const raw = tok ? canonicalToTokenRaw(canonical, tok) : canonical;
      const display = ARC.formatAmt(raw, tok?.decimals || CANONICAL_DECIMALS, 4);
      return { chainKey: ck, domain: b.domain, canonical, raw, display, depositor: b.depositor };
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

  async function listPendingWithdrawals(chainKey, addr) {
    const c = ARC.CHAINS[chainKey];
    const tok = usdcOnChain(chainKey);
    const wallet = new Contract(c.contracts.gatewayWallet, ARC.ABIS.gatewayWallet, ARC.rpcProvider(chainKey));
    return await wallet.getWithdrawals(tok.address, getAddress(addr));
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
  async function spend({ srcChainKey, dstChainKey, recipient, valueCanonical, maxFee = 0n, onStep }) {
    const intent = buildBurnIntent({ srcChainKey, dstChainKey, recipient, valueCanonical, maxFee });
    const attResp = await signAndSubmitBurnIntent(intent, { onStep });
    const mint = await gatewayMint(dstChainKey, attResp.attestation, attResp.signature, { onStep });
    return { intent, attResp, mint };
  }

  // ───────── EXPORTS ─────────
  ARC.gateway = {
    GW_BASE, EIP712_DOMAIN, EIP712_TYPES, CANONICAL_DECIMALS,
    gatewayChains, chainByDomain, usdcOnChain,
    canonicalToTokenRaw,
    readBalances, readBalanceOnChain,
    deposit, initiateWithdrawal, finalizeWithdrawal,
    listPendingWithdrawals, withdrawalDelay,
    buildBurnIntent, signAndSubmitBurnIntent, gatewayMint, spend,
  };
})(window);
