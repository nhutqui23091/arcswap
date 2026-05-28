import { createAppKit } from '@reown/appkit';
import { defineChain } from '@reown/appkit/networks';
import { EthersAdapter } from '@reown/appkit-adapter-ethers';

// Expose on window so arc-core.js can use synchronously (no dynamic import needed)
window.ReownAppKit = { createAppKit, defineChain, EthersAdapter };
