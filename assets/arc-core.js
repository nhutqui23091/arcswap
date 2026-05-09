/* ArcSwap shared core
 * Wallet / chain / RPC / token / format helpers built on ethers v6 (UMD).
 * Consumers must load ethers UMD before this file.
 */
(function (global) {
  'use strict';

  if (!global.ethers) {
    console.error('[arc-core] ethers UMD not found. Load ethers before arc-core.js');
    return;
  }
  const { BrowserProvider, JsonRpcProvider, Contract, Interface, getAddress, isAddress,
          formatUnits, parseUnits, keccak256, toUtf8Bytes, zeroPadValue, hexlify, toBeHex } = global.ethers;

  // ───────── CHAIN REGISTRY ─────────
  const CHAINS = {
    arc: {
      id: 5042002,
      hex: '0x4cef52',
      name: 'Arc Testnet',
      short: 'Arc',
      rpc: 'https://rpc.testnet.arc.network',
      explorer: 'https://testnet.arcscan.app',
      explorerTx: h => `https://testnet.arcscan.app/tx/${h}`,
      explorerAddr: a => `https://testnet.arcscan.app/address/${a}`,
      native: { symbol: 'USDC', name: 'USDC (Arc Gas)', decimals: 18 },
      cctpDomain: 26,
      iconGrad: 'linear-gradient(135deg,#6C3FFF,#00CFFF)',
      // Arc's USDC is the native gas token — it lives in the L1 ledger, not in
      // the ERC-20 wrapper at 0x3600…. Standard `approve` + `transferFrom`
      // (which GatewayWallet.deposit relies on) cannot move native balance, so
      // direct deposits revert with "ERC20: transfer amount exceeds balance".
      // Users should fund Arc by spending cross-chain (mint on Arc) instead.
      gatewayDepositDisabled: true,
      contracts: {
        router:              '0x48a9bd1644ac67fbef4183261c466bea3eb333fc',
        factory:             '0x45dd35611179ae6663ae47791175d7d598ced086',
        multicall3:          '0xcA11bde05977b3631167028862bE2a173976CA11',
        tokenMessengerV2:    '0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA',
        messageTransmitterV2:'0xE737e5cEBEEBa77EFE34D4aa090756590b1CE275',
        // Circle USYC Teller — ERC-4626 style subscribe/redeem between USDC (asset) and USYC (share)
        usycTeller:          '0x9fdF14c5B14173D74C08Af27AebFf39240dC105A',
        fxEscrow:            '0x867650F5eAe8df91445971f14d89fd84F0C9a9f8',
        gatewayWallet:       '0x0077777d7EBA4688BDeF3E311b846F25870A19B9',
        gatewayMinter:       '0x0022222ABE238Cc2C7Bb1f21003F0a260052475B',
      },
    },
    sepolia: {
      id: 11155111,
      hex: '0xaa36a7',
      name: 'Ethereum Sepolia',
      short: 'Sepolia',
      rpc: 'https://ethereum-sepolia-rpc.publicnode.com',
      explorer: 'https://sepolia.etherscan.io',
      explorerTx: h => `https://sepolia.etherscan.io/tx/${h}`,
      explorerAddr: a => `https://sepolia.etherscan.io/address/${a}`,
      native: { symbol: 'ETH', name: 'Sepolia ETH', decimals: 18 },
      cctpDomain: 0,
      iconGrad: 'linear-gradient(135deg,#627EEA,#8A9CF0)',
      contracts: {
        multicall3:          '0xcA11bde05977b3631167028862bE2a173976CA11',
        tokenMessengerV2:    '0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA',
        messageTransmitterV2:'0xE737e5cEBEEBa77EFE34D4aa090756590b1CE275',
        gatewayWallet:       '0x0077777d7EBA4688BDeF3E311b846F25870A19B9',
        gatewayMinter:       '0x0022222ABE238Cc2C7Bb1f21003F0a260052475B',
      },
    },
    // ── Additional Gateway-supported EVM testnets ──
    // GatewayWallet & GatewayMinter share the SAME address on every EVM chain
    // (deterministic-deploy via CREATE2). USDC addresses confirmed from Circle docs.
    baseSepolia: {
      id: 84532, hex: '0x14a34',
      name: 'Base Sepolia', short: 'Base',
      rpc: 'https://sepolia.base.org',
      explorer: 'https://sepolia.basescan.org',
      explorerTx: h => `https://sepolia.basescan.org/tx/${h}`,
      explorerAddr: a => `https://sepolia.basescan.org/address/${a}`,
      native: { symbol: 'ETH', name: 'Base Sepolia ETH', decimals: 18 },
      cctpDomain: 6,
      iconGrad: 'linear-gradient(135deg,#0052FF,#62A5FF)',
      contracts: {
        multicall3:    '0xcA11bde05977b3631167028862bE2a173976CA11',
        gatewayWallet: '0x0077777d7EBA4688BDeF3E311b846F25870A19B9',
        gatewayMinter: '0x0022222ABE238Cc2C7Bb1f21003F0a260052475B',
      },
    },
    avalancheFuji: {
      id: 43113, hex: '0xa869',
      name: 'Avalanche Fuji', short: 'Fuji',
      rpc: 'https://api.avax-test.network/ext/bc/C/rpc',
      explorer: 'https://testnet.snowtrace.io',
      explorerTx: h => `https://testnet.snowtrace.io/tx/${h}`,
      explorerAddr: a => `https://testnet.snowtrace.io/address/${a}`,
      native: { symbol: 'AVAX', name: 'Fuji AVAX', decimals: 18 },
      cctpDomain: 1,
      iconGrad: 'linear-gradient(135deg,#E84142,#F87C7D)',
      contracts: {
        multicall3:    '0xcA11bde05977b3631167028862bE2a173976CA11',
        gatewayWallet: '0x0077777d7EBA4688BDeF3E311b846F25870A19B9',
        gatewayMinter: '0x0022222ABE238Cc2C7Bb1f21003F0a260052475B',
      },
    },
    arbitrumSepolia: {
      id: 421614, hex: '0x66eee',
      name: 'Arbitrum Sepolia', short: 'Arb Sep',
      rpc: 'https://sepolia-rollup.arbitrum.io/rpc',
      explorer: 'https://sepolia.arbiscan.io',
      explorerTx: h => `https://sepolia.arbiscan.io/tx/${h}`,
      explorerAddr: a => `https://sepolia.arbiscan.io/address/${a}`,
      native: { symbol: 'ETH', name: 'Arb Sepolia ETH', decimals: 18 },
      cctpDomain: 3,
      iconGrad: 'linear-gradient(135deg,#28A0F0,#80C8F8)',
      contracts: {
        multicall3:    '0xcA11bde05977b3631167028862bE2a173976CA11',
        gatewayWallet: '0x0077777d7EBA4688BDeF3E311b846F25870A19B9',
        gatewayMinter: '0x0022222ABE238Cc2C7Bb1f21003F0a260052475B',
      },
    },
    optimismSepolia: {
      id: 11155420, hex: '0xaa37dc',
      name: 'OP Sepolia', short: 'OP Sep',
      // sepolia.optimism.io throttles aggressively → "could not coalesce error".
      // publicnode is more reliable for browser use.
      rpc: 'https://optimism-sepolia.publicnode.com',
      explorer: 'https://sepolia-optimism.etherscan.io',
      explorerTx: h => `https://sepolia-optimism.etherscan.io/tx/${h}`,
      explorerAddr: a => `https://sepolia-optimism.etherscan.io/address/${a}`,
      native: { symbol: 'ETH', name: 'OP Sepolia ETH', decimals: 18 },
      cctpDomain: 2,
      iconGrad: 'linear-gradient(135deg,#FF0420,#FF6B7E)',
      contracts: {
        multicall3:    '0xcA11bde05977b3631167028862bE2a173976CA11',
        gatewayWallet: '0x0077777d7EBA4688BDeF3E311b846F25870A19B9',
        gatewayMinter: '0x0022222ABE238Cc2C7Bb1f21003F0a260052475B',
      },
    },
    polygonAmoy: {
      id: 80002, hex: '0x13882',
      name: 'Polygon Amoy', short: 'Amoy',
      rpc: 'https://rpc-amoy.polygon.technology',
      explorer: 'https://amoy.polygonscan.com',
      explorerTx: h => `https://amoy.polygonscan.com/tx/${h}`,
      explorerAddr: a => `https://amoy.polygonscan.com/address/${a}`,
      native: { symbol: 'POL', name: 'Polygon Amoy POL', decimals: 18 },
      cctpDomain: 7,
      iconGrad: 'linear-gradient(135deg,#8247E5,#B58CF0)',
      contracts: {
        multicall3:    '0xcA11bde05977b3631167028862bE2a173976CA11',
        gatewayWallet: '0x0077777d7EBA4688BDeF3E311b846F25870A19B9',
        gatewayMinter: '0x0022222ABE238Cc2C7Bb1f21003F0a260052475B',
      },
    },
    unichainSepolia: {
      id: 1301, hex: '0x515',
      name: 'Unichain Sepolia', short: 'Unichain',
      rpc: 'https://sepolia.unichain.org',
      explorer: 'https://sepolia.uniscan.xyz',
      explorerTx: h => `https://sepolia.uniscan.xyz/tx/${h}`,
      explorerAddr: a => `https://sepolia.uniscan.xyz/address/${a}`,
      native: { symbol: 'ETH', name: 'Unichain Sep ETH', decimals: 18 },
      cctpDomain: 10,
      iconGrad: 'linear-gradient(135deg,#FF007A,#FF66B0)',
      contracts: {
        multicall3:    '0xcA11bde05977b3631167028862bE2a173976CA11',
        gatewayWallet: '0x0077777d7EBA4688BDeF3E311b846F25870A19B9',
        gatewayMinter: '0x0022222ABE238Cc2C7Bb1f21003F0a260052475B',
      },
    },
  };

  // ───────── TOKEN REGISTRY ─────────
  // Arc's USDC IS the native gas token — it stores balances internally at 18 decimals
  // (same as ETH/wei on other EVM chains), even though the Circle USDC logical
  // convention is 6. That means: balanceOf()/transfer()/approve() on 0x3600…0000
  // all operate in 18-decimal raw units. We model it as decimals=18 for the UI and
  // same-chain flows. For CCTP messages (canonical 6-decimal), we scale with
  // `cctpDecimals` at the burn/mint boundary.
  const TOKENS = {
    arc: {
      USDC: {
        symbol: 'USDC',
        name: 'USD Coin (Arc native)',
        address: '0x3600000000000000000000000000000000000000',
        decimals: 18,
        cctpDecimals: 6,
        isGasToken: true, // display hint — fees come from this balance
        icon: 'https://cryptologos.cc/logos/usd-coin-usdc-logo.png',
      },
      EURC: {
        symbol: 'EURC',
        name: 'Euro Coin',
        address: '0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a',
        decimals: 6,
        icon: 'https://assets.coingecko.com/coins/images/26045/small/euro.png',
      },
      USYC: {
        symbol: 'USYC',
        name: 'US Yield Coin',
        address: '0xe9185F0c5F296Ed1797AaE4238D26CCaBEadb86C',
        decimals: 6,
        icon: 'https://assets.coingecko.com/coins/images/32800/small/USYC_icon.png',
      },
    },
    sepolia: {
      USDC: {
        symbol: 'USDC',
        name: 'USD Coin (CCTP v2)',
        address: '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238',
        decimals: 6,
        icon: 'https://cryptologos.cc/logos/usd-coin-usdc-logo.png',
      },
      ETH: {
        symbol: 'ETH',
        name: 'Sepolia ETH',
        address: '0x0000000000000000000000000000000000000000',
        decimals: 18,
        isGas: true,
        icon: 'https://cryptologos.cc/logos/ethereum-eth-logo.png',
      },
    },
    baseSepolia: {
      USDC: { symbol:'USDC', name:'USD Coin (Base Sepolia)', address:'0x036CbD53842c5426634e7929541eC2318f3dCF7e', decimals:6, icon:'https://cryptologos.cc/logos/usd-coin-usdc-logo.png' },
    },
    avalancheFuji: {
      USDC: { symbol:'USDC', name:'USD Coin (Fuji)', address:'0x5425890298aed601595a70AB815c96711a31Bc65', decimals:6, icon:'https://cryptologos.cc/logos/usd-coin-usdc-logo.png' },
    },
    arbitrumSepolia: {
      USDC: { symbol:'USDC', name:'USD Coin (Arb Sepolia)', address:'0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d', decimals:6, icon:'https://cryptologos.cc/logos/usd-coin-usdc-logo.png' },
    },
    optimismSepolia: {
      USDC: { symbol:'USDC', name:'USD Coin (OP Sepolia)', address:'0x5fd84259d66Cd46123540766Be93DFE6D43130D7', decimals:6, icon:'https://cryptologos.cc/logos/usd-coin-usdc-logo.png' },
    },
    polygonAmoy: {
      USDC: { symbol:'USDC', name:'USD Coin (Amoy)', address:'0x41E94Eb019C0762f9Bfcf9Fb1E58725BfB0e7582', decimals:6, icon:'https://cryptologos.cc/logos/usd-coin-usdc-logo.png' },
    },
    unichainSepolia: {
      USDC: { symbol:'USDC', name:'USD Coin (Unichain Sep)', address:'0x31d0220469e10c4E71834a79b1f276d740d3768F', decimals:6, icon:'https://cryptologos.cc/logos/usd-coin-usdc-logo.png' },
    },
  };

  // ───────── ABIs ─────────
  const ABIS = {
    erc20: [
      'function name() view returns (string)',
      'function symbol() view returns (string)',
      'function decimals() view returns (uint8)',
      'function totalSupply() view returns (uint256)',
      'function balanceOf(address) view returns (uint256)',
      'function allowance(address owner, address spender) view returns (uint256)',
      'function approve(address spender, uint256 amount) returns (bool)',
      'function transfer(address to, uint256 amount) returns (bool)',
      'event Transfer(address indexed from, address indexed to, uint256 value)',
      'event Approval(address indexed owner, address indexed spender, uint256 value)',
    ],
    factory: [
      'function getPair(address tokenA, address tokenB) view returns (address)',
      'function allPairsLength() view returns (uint256)',
      'function allPairs(uint256) view returns (address)',
      'event PairCreated(address indexed token0, address indexed token1, address pair, uint256)',
    ],
    pair: [
      'function token0() view returns (address)',
      'function token1() view returns (address)',
      'function getReserves() view returns (uint112, uint112, uint32)',
      'function totalSupply() view returns (uint256)',
      'function balanceOf(address) view returns (uint256)',
      'event Swap(address indexed sender, uint256 amount0In, uint256 amount1In, uint256 amount0Out, uint256 amount1Out, address indexed to)',
      'event Mint(address indexed sender, uint256 amount0, uint256 amount1)',
      'event Burn(address indexed sender, uint256 amount0, uint256 amount1, address indexed to)',
    ],
    router: [
      'function getAmountsOut(uint256 amountIn, address[] path) view returns (uint256[] amounts)',
      'function getAmountsIn(uint256 amountOut, address[] path) view returns (uint256[] amounts)',
      'function swapExactTokensForTokens(uint256 amountIn, uint256 amountOutMin, address[] path, address to, uint256 deadline) returns (uint256[] amounts)',
      'function swapTokensForExactTokens(uint256 amountOut, uint256 amountInMax, address[] path, address to, uint256 deadline) returns (uint256[] amounts)',
      'function addLiquidity(address tokenA, address tokenB, uint256 amountADesired, uint256 amountBDesired, uint256 amountAMin, uint256 amountBMin, address to, uint256 deadline) returns (uint256, uint256, uint256)',
      'function removeLiquidity(address tokenA, address tokenB, uint256 liquidity, uint256 amountAMin, uint256 amountBMin, address to, uint256 deadline) returns (uint256, uint256)',
    ],
    multicall3: [
      'function aggregate3(tuple(address target, bool allowFailure, bytes callData)[] calls) payable returns (tuple(bool success, bytes returnData)[] returnData)',
      'function getEthBalance(address) view returns (uint256)',
      'function getBlockNumber() view returns (uint256)',
      'function getCurrentBlockTimestamp() view returns (uint256)',
    ],
    tokenMessengerV2: [
      'function depositForBurn(uint256 amount, uint32 destinationDomain, bytes32 mintRecipient, address burnToken, bytes32 destinationCaller, uint256 maxFee, uint32 minFinalityThreshold)',
      'event DepositForBurn(address indexed burnToken, uint256 amount, address indexed depositor, bytes32 mintRecipient, uint32 destinationDomain, bytes32 destinationTokenMessenger, bytes32 destinationCaller, uint256 maxFee, uint32 indexed minFinalityThreshold, bytes hookData)',
    ],
    messageTransmitterV2: [
      'function receiveMessage(bytes message, bytes attestation) returns (bool)',
      'function usedNonces(bytes32) view returns (uint256)',
      'event MessageReceived(address indexed caller, uint32 sourceDomain, bytes32 indexed nonce, bytes32 sender, uint32 indexed finalityThresholdExecuted, bytes messageBody)',
    ],
    // ── Circle Gateway ──
    // Single GatewayWallet contract per chain holds user-deposited USDC and tracks
    // it as a *unified balance* spendable via signed BurnIntent on any other chain.
    gatewayWallet: [
      // Verified against on-chain implementation 0xcf3F2Ab96967e755Cd56CeaCcEB276E437288858
      'function deposit(address token, uint256 value)',
      'function depositFor(address token, address depositor, uint256 value)',
      'function initiateWithdrawal(address token, uint256 value)',
      'function withdraw(address token)',
      'function availableBalance(address token, address depositor) view returns (uint256)',
      'function totalBalance(address token, address depositor) view returns (uint256)',
      'function withdrawingBalance(address token, address depositor) view returns (uint256)',
      'function withdrawableBalance(address token, address depositor) view returns (uint256)',
      'function withdrawalBlock(address token, address depositor) view returns (uint256)',
      'function withdrawalDelay() view returns (uint256)',
      'function isTokenSupported(address token) view returns (bool)',
      'event Deposited(address indexed token, address indexed depositor, address indexed sender, uint256 value)',
    ],
    gatewayMinter: [
      'function gatewayMint(bytes attestationPayload, bytes signature)',
      'event Minted(address indexed token, address indexed recipient, uint256 value)',
    ],
    usycTeller: [
      // ERC-4626-like subscribe / redeem
      'function asset() view returns (address)',
      'function share() view returns (address)',
      'function totalAssets() view returns (uint256)',
      'function mintPrice() view returns (int256)',
      'function convertToShares(uint256 assets) view returns (uint256)',
      'function convertToAssets(uint256 shares) view returns (uint256)',
      'function previewDeposit(uint256 assets) view returns (uint256)',
      'function previewMint(uint256 shares) view returns (uint256)',
      'function previewRedeem(uint256 shares) view returns (uint256)',
      'function previewWithdraw(uint256 assets) view returns (uint256)',
      'function maxDeposit(address account) view returns (uint256)',
      'function maxMint(address account) view returns (uint256)',
      'function maxRedeem(address account) view returns (uint256)',
      'function maxWithdraw(address account) view returns (uint256)',
      'function subscriptionFeeRate(address account) view returns (uint256)',
      'function redemptionFeeRate(address account) view returns (uint256)',
      'function deposit(uint256 assets, address receiver) returns (uint256)',
      'function mint(uint256 shares, address receiver) returns (uint256)',
      'function redeem(uint256 shares, address receiver, address account) returns (uint256)',
      'function withdraw(uint256 assets, address receiver, address account) returns (uint256)',
      'function afterHourTrading() view returns (uint256)',
      'function isDST() view returns (bool)',
      'function todayTimestamp() view returns (uint256)',
      'function oracle() view returns (address)',
    ],
  };

  // ───────── PROVIDERS ─────────
  const rpcProviders = {};
  function rpcProvider(chainKey) {
    if (!rpcProviders[chainKey]) {
      const c = CHAINS[chainKey];
      if (!c) throw new Error('Unknown chain ' + chainKey);
      rpcProviders[chainKey] = new JsonRpcProvider(c.rpc, { name: c.name, chainId: c.id }, { staticNetwork: true });
    }
    return rpcProviders[chainKey];
  }

  function chainKeyById(id) {
    for (const [k, v] of Object.entries(CHAINS)) if (Number(v.id) === Number(id)) return k;
    return null;
  }

  // ───────── WALLET ─────────
  const wallet = {
    provider: null,
    signer: null,
    address: null,
    chainKey: null,
    _eth: null,
    _listeners: new Set(),

    on(cb) { this._listeners.add(cb); return () => this._listeners.delete(cb); },
    _emit() { for (const cb of this._listeners) { try { cb(this.snapshot()); } catch {} } },
    snapshot() {
      return { address: this.address, chainKey: this.chainKey, connected: !!this.address };
    },

    // EIP-6963 wallet discovery: modern standard that lets multiple wallets
    // (MetaMask, Rabby, Coinbase, OKX, …) coexist without stomping on
    // window.ethereum. Browsers without any wallet won't respond.
    _eip6963Providers: [],
    _eip6963Init() {
      if (this._eip6963Bound) return;
      this._eip6963Bound = true;
      window.addEventListener('eip6963:announceProvider', (e) => {
        const detail = e.detail; if (!detail?.provider) return;
        if (!this._eip6963Providers.find(p => p.info?.uuid === detail.info?.uuid)) {
          this._eip6963Providers.push(detail);
        }
      });
      window.dispatchEvent(new Event('eip6963:requestProvider'));
    },

    // EVM-first priority. Phantom + Keplr support EVM but their primary chains
    // are Solana / Cosmos, so they go LAST — users typically have them installed
    // for those ecosystems and don't expect them to be the default for an EVM dApp.
    _PROVIDER_PRIORITY: {
      'io.metamask': 1,
      'com.okxwallet': 2,
      'io.rabby': 3,
      'com.coinbase.wallet': 4,
      'com.coinbase.coinbasewallet': 4,
      'com.trustwallet.app': 5,
      'com.brave.wallet': 6,
      'walletconnect': 7,
      // Multi-chain wallets — deprioritized for EVM dApps
      'app.phantom': 90,
      'app.keplr': 95,
    },

    /**
     * Returns all detected wallets, sorted by EVM priority (MetaMask → OKX → ...).
     * Each entry: { info: {name, rdns, icon, uuid}, provider }.
     * Includes a synthetic legacy entry for `window.ethereum` if it's NOT one of
     * the EIP-6963 announcements (avoids dup) and looks like a real provider.
     */
    listProviders() {
      this._eip6963Init();
      const list = [...this._eip6963Providers];
      // If window.ethereum exists but isn't in any 6963 announcement, add it as
      // a fallback option (some wallet builds still don't announce 6963).
      const legacy = global.ethereum;
      if (legacy && !list.some(p => p.provider === legacy)) {
        let name = 'Browser Wallet';
        if (legacy.isMetaMask && !legacy.isRabby) name = 'MetaMask (legacy)';
        else if (legacy.isRabby) name = 'Rabby (legacy)';
        else if (legacy.isOkxWallet) name = 'OKX Wallet (legacy)';
        else if (legacy.isCoinbaseWallet) name = 'Coinbase Wallet (legacy)';
        list.push({
          info: { name, rdns: 'legacy.window.ethereum', icon: null, uuid: 'legacy-ethereum' },
          provider: legacy,
        });
      }
      const PRIO = this._PROVIDER_PRIORITY;
      list.sort((a, b) => {
        const pa = PRIO[a.info?.rdns] ?? 50;
        const pb = PRIO[b.info?.rdns] ?? 50;
        if (pa !== pb) return pa - pb;
        return (a.info?.name || '').localeCompare(b.info?.name || '');
      });
      return list;
    },

    /**
     * Resolve which provider to use for connect.
     * Lookup order:
     *   1. Explicit `rdns` arg (when user picked from picker UI)
     *   2. Last-used RDNS from localStorage
     *   3. Top of priority list (MetaMask preferred)
     */
    eip1193(rdns) {
      const list = this.listProviders();
      if (!list.length) return null;
      if (rdns) {
        const m = list.find(p => p.info?.rdns === rdns);
        if (m) return m.provider;
      }
      try {
        const saved = localStorage.getItem('arc.wallet.rdns');
        if (saved) {
          const m = list.find(p => p.info?.rdns === saved);
          if (m) return m.provider;
        }
      } catch {}
      return list[0].provider;
    },

    /** Returns a friendly description of why no wallet was detected. */
    _noWalletReason() {
      // Common diagnoses to help the user fix it themselves
      const ua = (navigator.userAgent || '').toLowerCase();
      if (/firefox/.test(ua)) {
        return 'No wallet extension detected. Install MetaMask for Firefox or Rabby, then reload this page.';
      }
      // Detect private/incognito (best-effort: extensions are usually disabled there)
      const isInPrivate = !window.indexedDB || (() => {
        try { localStorage.setItem('__t__', '1'); localStorage.removeItem('__t__'); return false; } catch { return true; }
      })();
      if (isInPrivate) {
        return 'No wallet detected. Browser extensions are usually disabled in Incognito/Private mode — open this site in a normal window.';
      }
      return 'No wallet extension detected. Install MetaMask (metamask.io), Rabby, or OKX Wallet, then reload this page.';
    },

    async connect(rdns) {
      const eth = this.eip1193(rdns);
      if (!eth) throw new Error(this._noWalletReason());
      // Remember which wallet for next time so user doesn't keep re-picking
      try {
        const info = this.listProviders().find(p => p.provider === eth)?.info;
        if (info?.rdns) localStorage.setItem('arc.wallet.rdns', info.rdns);
      } catch {}
      this._eth = eth;
      const accounts = await eth.request({ method: 'eth_requestAccounts' });
      if (!accounts || !accounts.length) throw new Error('Wallet returned no accounts');
      this.provider = new BrowserProvider(eth, 'any');
      this.signer = await this.provider.getSigner();
      this.address = getAddress(accounts[0]);
      const net = await this.provider.getNetwork();
      this.chainKey = chainKeyById(net.chainId);
      if (!eth._arcBound) {
        eth._arcBound = true;
        eth.on?.('accountsChanged', async (accs) => {
          if (!accs || !accs.length) { this.disconnect(); return; }
          this.address = getAddress(accs[0]);
          if (this.provider) this.signer = await this.provider.getSigner();
          this._emit();
        });
        eth.on?.('chainChanged', async (cid) => {
          this.chainKey = chainKeyById(parseInt(cid, 16));
          if (this._eth) this.provider = new BrowserProvider(this._eth, 'any');
          if (this.provider && this.address) this.signer = await this.provider.getSigner();
          this._emit();
        });
      }
      try { localStorage.setItem('arc.wallet.autoconnect', '1'); } catch {}
      this._emit();
      return this.snapshot();
    },

    disconnect() {
      this.provider = null; this.signer = null; this.address = null; this.chainKey = null;
      try { localStorage.removeItem('arc.wallet.autoconnect'); } catch {}
      this._emit();
    },

    async autoConnect() {
      try {
        if (localStorage.getItem('arc.wallet.autoconnect') !== '1') return null;
      } catch {}
      const eth = this.eip1193(); if (!eth) return null;
      try {
        const accs = await eth.request({ method: 'eth_accounts' });
        if (accs && accs.length) return await this.connect();
      } catch {}
      return null;
    },

    async ensureChain(chainKey) {
      const eth = this.eip1193(); if (!eth) throw new Error('No wallet');
      const c = CHAINS[chainKey]; if (!c) throw new Error('Unknown chain ' + chainKey);
      const current = await eth.request({ method: 'eth_chainId' });
      if (parseInt(current, 16) === c.id) return;
      try {
        await eth.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: c.hex }] });
      } catch (err) {
        if (err.code === 4902 || /Unrecognized chain/i.test(err.message || '')) {
          await eth.request({
            method: 'wallet_addEthereumChain',
            params: [{
              chainId: c.hex,
              chainName: c.name,
              rpcUrls: [c.rpc],
              nativeCurrency: { name: c.native.name, symbol: c.native.symbol, decimals: c.native.decimals },
              blockExplorerUrls: [c.explorer],
            }],
          });
        } else { throw err; }
      }
      this.provider = new BrowserProvider(eth, 'any');
      this.signer = await this.provider.getSigner();
      this.chainKey = chainKey;
      this._emit();
    },
  };

  // ───────── TOKEN HELPERS ─────────
  async function tokenBalance(chainKey, token, addr) {
    const prov = rpcProvider(chainKey);
    // Pure native gas (Sepolia ETH): use eth_getBalance.
    if (token.isGas) return await prov.getBalance(addr);
    // Arc's USDC = native gas but also exposed as ERC-20 at 0x3600…. In practice
    // balances live in the native ledger — eth_getBalance is canonical and always
    // matches what MetaMask shows. We query BOTH in parallel and return whichever
    // is non-zero (native takes priority on tie). This makes the UI robust no
    // matter whether a given wallet stores value natively or via the wrapper.
    if (token.isGasToken) {
      try {
        const [nat, erc] = await Promise.all([
          prov.getBalance(addr).catch(() => 0n),
          new Contract(token.address, ABIS.erc20, prov).balanceOf(addr).catch(() => 0n),
        ]);
        return nat > 0n ? nat : erc;
      } catch { return 0n; }
    }
    const c = new Contract(token.address, ABIS.erc20, prov);
    return await c.balanceOf(addr);
  }

  async function allowance(chainKey, token, owner, spender) {
    if (token.isGas) return (1n << 255n); // pure native, no allowance needed
    const c = new Contract(token.address, ABIS.erc20, rpcProvider(chainKey));
    return await c.allowance(owner, spender);
  }

  async function ensureAllowance(chainKey, token, spender, amount, onStep) {
    if (token.isGas) return null;
    const have = await allowance(chainKey, token, wallet.address, spender);
    if (have >= amount) return null;
    onStep?.('Requesting approval…');
    const c = new Contract(token.address, ABIS.erc20, wallet.signer);
    const tx = await c.approve(spender, (1n << 256n) - 1n);
    onStep?.('Approving… ' + tx.hash.slice(0, 10));
    await tx.wait();
    return tx.hash;
  }

  function formatAmt(v, decimals, maxFrac = 6) {
    try {
      const s = formatUnits(v, decimals);
      const [int, frac = ''] = s.split('.');
      if (!frac) return int;
      const f = frac.slice(0, maxFrac).replace(/0+$/, '');
      return f ? `${int}.${f}` : int;
    } catch { return '0'; }
  }

  function parseAmt(s, decimals) {
    if (!s) return 0n;
    const clean = String(s).replace(/,/g, '').trim();
    if (!/^\d*\.?\d*$/.test(clean) || clean === '' || clean === '.') return 0n;
    try { return parseUnits(clean, decimals); } catch { return 0n; }
  }

  function shortAddr(a) { return a ? `${a.slice(0, 6)}…${a.slice(-4)}` : ''; }

  function addrToBytes32(a) {
    if (!isAddress(a)) throw new Error('Bad address');
    return zeroPadValue(getAddress(a), 32);
  }

  // Convert a token amount (raw bigint at token.decimals) to the CCTP canonical
  // 6-decimal scale used by TokenMessenger.depositForBurn. For standard USDC
  // (6 decimals) this is a no-op; for Arc USDC (18 decimals native) we /10^12.
  function toCctpAmount(amount, token) {
    const d = token.cctpDecimals ?? 6;
    if (token.decimals === d) return amount;
    if (token.decimals > d) return amount / (10n ** BigInt(token.decimals - d));
    return amount * (10n ** BigInt(d - token.decimals));
  }
  function fromCctpAmount(amount, token) {
    const d = token.cctpDecimals ?? 6;
    if (token.decimals === d) return amount;
    if (token.decimals > d) return amount * (10n ** BigInt(token.decimals - d));
    return amount / (10n ** BigInt(d - token.decimals));
  }

  // ───────── MULTICALL ─────────
  async function multicall(chainKey, calls /* [{target, data, allowFailure?}] */) {
    const c = CHAINS[chainKey];
    const mc = new Contract(c.contracts.multicall3, ABIS.multicall3, rpcProvider(chainKey));
    const input = calls.map(x => ({ target: x.target, allowFailure: x.allowFailure !== false, callData: x.data }));
    const res = await mc.aggregate3.staticCall(input);
    return res.map((r, i) => ({ success: r.success, data: r.returnData, decode: (types) => {
      const iface = global.ethers.AbiCoder.defaultAbiCoder();
      try { return iface.decode(types, r.returnData); } catch { return null; }
    }}));
  }

  // ───────── TX LIFECYCLE ─────────
  async function sendAndWait(signer, populated, { onSent, onMined, onError, timeoutMs = 180000 } = {}) {
    try {
      const tx = await signer.sendTransaction(populated);
      onSent?.(tx);
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const r = await signer.provider.getTransactionReceipt(tx.hash).catch(() => null);
        if (r) { onMined?.(r); return { tx, receipt: r }; }
        await new Promise(r => setTimeout(r, 1500));
      }
      onMined?.(null);
      return { tx, receipt: null };
    } catch (e) {
      onError?.(e);
      throw e;
    }
  }

  function explainError(e) {
    if (!e) return 'Unknown error';
    const msg = (e.info?.error?.message || e.shortMessage || e.message || '').toString();
    if (e.code === 'ACTION_REJECTED' || /user rejected|user denied/i.test(msg)) return 'Rejected in wallet';
    if (/insufficient funds/i.test(msg)) return 'Insufficient funds for gas';
    if (/INSUFFICIENT_OUTPUT_AMOUNT/i.test(msg)) return 'Slippage too tight — price moved';
    if (/INSUFFICIENT_LIQUIDITY/i.test(msg)) return 'Not enough pool liquidity';
    if (/nonce/i.test(msg)) return 'Nonce error — reset wallet activity';
    if (/replacement fee too low/i.test(msg)) return 'Replacement fee too low';
    return msg.slice(0, 160);
  }

  // ───────── IRIS / CCTP v2 ─────────
  const IRIS_BASE = 'https://iris-api-sandbox.circle.com/v2';

  async function irisMessages(sourceDomain, txHash) {
    const url = `${IRIS_BASE}/messages/${sourceDomain}?transactionHash=${txHash}`;
    const r = await fetch(url);
    if (!r.ok) throw new Error(`IRIS ${r.status}`);
    return await r.json();
  }

  async function irisFastAllowance() {
    try {
      const r = await fetch(`${IRIS_BASE}/fastBurnAllowance`);
      if (!r.ok) return null;
      return await r.json();
    } catch { return null; }
  }

  // ───────── EXPORTS ─────────
  global.ARC = {
    CHAINS, TOKENS, ABIS,
    rpcProvider, chainKeyById,
    wallet,
    tokenBalance, allowance, ensureAllowance,
    formatAmt, parseAmt, shortAddr, addrToBytes32,
    toCctpAmount, fromCctpAmount,
    multicall, sendAndWait, explainError,
    irisMessages, irisFastAllowance, IRIS_BASE,
    // List of chain keys that have a GatewayWallet deployed (used by arc-gateway.js)
    gatewayChains: () => Object.entries(CHAINS)
      .filter(([, c]) => c.contracts?.gatewayWallet)
      .map(([k]) => k),
    chainIcon,
    version: '9.4.2',
  };

  // ───────── CHAIN ICONS ─────────
  // Hand-crafted SVG data URIs — recognizable brand marks for each chain.
  // Inline so they always render (no CDN dependency, no CSP changes needed).
  // Keep them minimal but distinctive so users can scan the picker visually.
  const CHAIN_ICONS = {
    arc: "data:image/svg+xml;utf8,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Cdefs%3E%3ClinearGradient id='ag' x1='0%25' y1='0%25' x2='100%25' y2='100%25'%3E%3Cstop offset='0%25' stop-color='%236C3FFF'/%3E%3Cstop offset='100%25' stop-color='%2300CFFF'/%3E%3C/linearGradient%3E%3C/defs%3E%3Ccircle cx='16' cy='16' r='16' fill='url(%23ag)'/%3E%3Cpath fill='white' d='M11 22L16 9l5 13h-3l-1-3h-2l-1 3h-3zm5-7l-1 2h2l-1-2z'/%3E%3C/svg%3E",
    sepolia: "data:image/svg+xml;utf8,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Ccircle cx='16' cy='16' r='16' fill='%23627EEA'/%3E%3Cg fill='white'%3E%3Cpath opacity='0.6' d='M16 4v8.87l7.5 3.35z'/%3E%3Cpath d='M16 4l-7.5 12.22L16 12.87V4z'/%3E%3Cpath opacity='0.6' d='M16 21.97v6.03L23.5 17.62z'/%3E%3Cpath d='M16 28v-6.03L8.5 17.62 16 28z'/%3E%3Cpath opacity='0.2' d='M16 20.57l7.5-4.35L16 12.87v7.7z'/%3E%3Cpath opacity='0.6' d='M8.5 16.22L16 20.57v-7.7l-7.5 3.35z'/%3E%3C/g%3E%3C/svg%3E",
    baseSepolia: "data:image/svg+xml;utf8,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Ccircle cx='16' cy='16' r='16' fill='%230052FF'/%3E%3Cpath fill='white' d='M16 4a12 12 0 100 24 12 12 0 000-24zm0 4a8 8 0 110 16 8 8 0 010-16z' transform='translate(0 0)'/%3E%3Cpath fill='%230052FF' d='M16 24a8 8 0 100-16v16z'/%3E%3C/svg%3E",
    avalancheFuji: "data:image/svg+xml;utf8,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Ccircle cx='16' cy='16' r='16' fill='%23E84142'/%3E%3Cpath fill='white' d='M21 22h4l-2-3.5h-4zm-4-7l5-8.5h-3.5L13.5 15zm-3.5 7L9 13l-4 7c-.5 1 0 2 1 2h7.5z'/%3E%3C/svg%3E",
    arbitrumSepolia: "data:image/svg+xml;utf8,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Ccircle cx='16' cy='16' r='16' fill='%2328A0F0'/%3E%3Cpath fill='white' d='M16 6l-7 12 4 6 3-2-3-6 4-7-1-3zm2 4l5 8-3 6h-2l-2-3 2-3 1-3-1-5z'/%3E%3C/svg%3E",
    optimismSepolia: "data:image/svg+xml;utf8,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Ccircle cx='16' cy='16' r='16' fill='%23FF0420'/%3E%3Cpath fill='white' d='M11 12c-2.5 0-4 1.5-4 4s1.5 4 4 4 4-1.5 4-4-1.5-4-4-4zm0 6c-1 0-2-1-2-2s1-2 2-2 2 1 2 2-1 2-2 2zm10-6h-3l-1 8h2l.3-2.5h.7c2 0 3.5-1 4-3 0-1.5-1-2.5-3-2.5zm-.5 4h-1l.3-2h1c.5 0 1 .3 1 1 0 .5-.5 1-1.3 1z'/%3E%3C/svg%3E",
    polygonAmoy: "data:image/svg+xml;utf8,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Ccircle cx='16' cy='16' r='16' fill='%238247E5'/%3E%3Cpath fill='white' d='M21.6 13.2L19 11.7c-.3-.2-.7-.2-1 0l-2.5 1.5-1.7 1-2.5 1.5c-.3.2-.7.2-1 0l-2-1.2c-.3-.2-.5-.5-.5-.9v-2.4c0-.4.2-.7.5-.9l2-1.1c.3-.2.7-.2 1 0l2 1.1c.3.2.5.5.5.9v1.5l1.7-1V8.4c0-.4-.2-.7-.5-.9L11.5 6c-.3-.2-.7-.2-1 0L6.5 8.5c-.3.2-.5.5-.5.9V13c0 .4.2.7.5.9l4 2.4c.3.2.7.2 1 0l2.5-1.5 1.7-1 2.5-1.5c.3-.2.7-.2 1 0l2 1.1c.3.2.5.5.5.9v2.4c0 .4-.2.7-.5.9l-2 1.2c-.3.2-.7.2-1 0l-2-1.1c-.3-.2-.5-.5-.5-.9v-1.5l-1.7 1v1.5c0 .4.2.7.5.9l4 2.4c.3.2.7.2 1 0l4-2.5c.3-.2.5-.5.5-.9v-4.5c0-.4-.2-.7-.5-.9z'/%3E%3C/svg%3E",
    unichainSepolia: "data:image/svg+xml;utf8,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Ccircle cx='16' cy='16' r='16' fill='%23FF007A'/%3E%3Cpath fill='white' d='M14.5 7c-.3 4 .3 6 1.5 7-1.5-.5-3-2-3.5-4 .5 4 2.5 6 5 6.5-1 .5-3 .5-4-.5 1 1.5 2.5 2.5 4.5 2.5-1 1-2.5 1.5-4.5 1.5C16 22 19 20 19.5 16c.5 4-1 7-3.5 8.5C19 24 22 21 22 16.5 22 11 18 7 14.5 7z'/%3E%3C/svg%3E",
  };
  function chainIcon(chainKey) {
    return CHAIN_ICONS[chainKey] || CHAIN_ICONS.arc;
  }
})(window);
