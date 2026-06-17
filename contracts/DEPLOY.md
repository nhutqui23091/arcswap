# Deploy OneliqCheckIn to Arc Testnet (Remix)

On-chain proof for the office-hours form. ~5 minutes, no local toolchain.

## Arc Testnet network details
| | |
|---|---|
| Network name | Arc Testnet |
| RPC URL | `https://rpc.testnet.arc.network` |
| Chain ID | `5042002` |
| Currency symbol | `USDC` (native gas) |
| Block explorer | `https://testnet.arcscan.app` |

You need a little **testnet USDC** in your wallet to pay gas. Use the same wallet you connect to the Portal (it should already be funded from earlier swaps).

## Steps
1. Open <https://remix.ethereum.org>.
2. Create a new file `OneliqCheckIn.sol` and paste the contents of [`OneliqCheckIn.sol`](OneliqCheckIn.sol).
3. **Solidity Compiler** tab → compiler `0.8.20` (or newer 0.8.x) → **Compile**.
4. **Deploy & Run Transactions** tab → Environment = **Injected Provider - MetaMask** (or your wallet).
5. In the wallet, switch to **Arc Testnet** (add it as a custom network with the values above if it isn't listed).
6. Make sure the selected contract is `OneliqCheckIn` → click **Deploy** → confirm in wallet.
7. After it confirms, copy:
   - **Contract address** (under *Deployed Contracts*).
   - **Deployer address** (your wallet address).
   - **Deploy tx hash** (from the wallet / Remix terminal) → view at `https://testnet.arcscan.app/tx/<hash>`.
8. (Optional, recommended) Call `checkIn()` once from Remix so there's a real interaction tx, not just the deploy.

## What to put in the submission form
> **Contract addresses deployed on testnet:**
> - OneliqCheckIn (daily check-in / streak): `0x...` — https://testnet.arcscan.app/address/0x...
> - Deployer: `0x...`
>
> No factory — single self-contained contract. Each user check-in is a real Arc Testnet transaction (verifiable on the explorer), backing the Oneliq Portal's daily-streak feature.

## Verify (optional but looks good)
On `testnet.arcscan.app`, open the contract address → if Arcscan supports source verification, paste the same `OneliqCheckIn.sol`, compiler `0.8.20`, no constructor args. Verified source + a read/write tab makes the submission stronger.

---

## Deployed addresses (Arc Testnet)
- **OneliqCheckIn**: `0x368a0E854ec69EC10b50D20fCaFC1bAF8b7eff10` — Sourcify verified
  https://testnet.arcscan.app/address/0x368a0E854ec69EC10b50D20fCaFC1bAF8b7eff10
- **OneliqRouter**: `0xb508F475230E4Ab876258B7DCaFbc182d806e1F7`
  https://testnet.arcscan.app/address/0xb508F475230E4Ab876258B7DCaFbc182d806e1F7

---

# Deploy OneliqRouter (contract #2)

A thin fee-router over the existing Circle/Curve USDC<->EURC pool. Same Remix flow:

1. Create `OneliqRouter.sol`, paste [`OneliqRouter.sol`](OneliqRouter.sol), compile `0.8.20`.
2. Deploy & Run → Browser Extension (OKX) → Arc Testnet → select **OneliqRouter** → **Deploy** (no constructor args).
3. Copy the contract address.

### Test a real swap through the router (recommended — gives an interaction tx)
All amounts are in **6-decimal token units**: `1 USDC = 1000000`, `1 EURC = 1000000`.

1. In **Deployed Contracts**, expand `OneliqRouter`.
2. First let the router pull your USDC: open the **USDC token** `0x3600000000000000000000000000000000000000` in Remix
   (Deploy tab → "At Address" with a minimal ERC-20 ABI, or just approve from OKX), and call
   `approve(spender = <router address>, amount = 1000000)` to allow 1 USDC.
   - Easiest alternative: skip manual approve and use the **`quote`** read first, then approve via the swap flow.
3. (Optional) Call `quote(USDC, EURC, 1000000)` → shows expected EURC out + fee.
4. Call `swap(tokenIn = 0x3600...0000, tokenOut = 0x89B5...D72a, amountIn = 1000000, minOut = 0)`.
   - `minOut = 0` is fine for a testnet test (no slippage protection). For production use the `quote` value minus slippage.
5. Confirm in OKX → you now have a swap tx routed through YOUR contract, with the 0.10% fee held in the router.

### Form answer (2 contracts)
> **Contracts deployed on Arc Testnet (chainId 5042002):**
> - OneliqCheckIn (daily check-in / streak): `0x368a0E854ec69EC10b50D20fCaFC1bAF8b7eff10`
> - OneliqRouter (USDC<->EURC fee-router over Circle/Curve pool): `0xb508F475230E4Ab876258B7DCaFbc182d806e1F7`
> - Deployer: `0x738...bC762` *(your full address)*
>
> Self-contained, no factory. OneliqRouter forwards swaps to Circle's existing Curve StableSwap pool and takes a 0.10% protocol fee — Oneliq's own on-chain entry point without holding liquidity.
