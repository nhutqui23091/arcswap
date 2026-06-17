// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title OneliqRouter
 * @notice Thin fee-taking router for USDC <-> EURC swaps on Arc Testnet.
 *
 * The router does NOT hold liquidity. It forwards the trade to the existing
 * Circle/Curve StableSwap pool (the same pool the Oneliq trade page already
 * routes through), takes a small protocol fee on the input token, and returns
 * the output token to the caller. This gives Oneliq an on-chain entry point it
 * controls (fees, analytics, future on-chain points) without taking on AMM /
 * market-making risk — liquidity stays in Curve.
 *
 * Flow (USDC -> EURC):
 *   1. user approves this router for `amountIn` USDC
 *   2. user calls swap(USDC, EURC, amountIn, minOut)
 *   3. router pulls USDC, keeps `feeBps`, approves the pool, calls exchange()
 *   4. pool sends EURC to the router, router forwards it to the user
 *
 * Arc Testnet: chainId 5042002, RPC https://rpc.testnet.arc.network
 * Curve pool : 0x2d84d79c852f6842abe0304b70bbaa1506add457 (USDC idx 0, EURC idx 1)
 */

interface IERC20 {
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function approve(address spender, uint256 amount) external returns (bool);
    function allowance(address owner, address spender) external view returns (uint256);
    function balanceOf(address account) external view returns (uint256);
}

interface ICurveStableSwap {
    function get_dy(int128 i, int128 j, uint256 dx) external view returns (uint256);
    function exchange(int128 i, int128 j, uint256 dx, uint256 min_dy) external returns (uint256);
}

contract OneliqRouter {
    // ---- Fixed Arc Testnet addresses (see Oneliq trade.html / arc-core-v2.js) ----
    // Written as bytes20 hex literals so the exact bytes from the repo are kept
    // verbatim and Solidity's EIP-55 checksum check does not apply.
    address public constant POOL = address(bytes20(hex"2d84d79c852f6842abe0304b70bbaa1506add457"));
    address public constant USDC = address(bytes20(hex"3600000000000000000000000000000000000000")); // pool coin index 0
    address public constant EURC = address(bytes20(hex"89b50855aa3be2f677cd6303cec089b5f319d72a")); // pool coin index 1

    uint256 public constant MAX_UINT = type(uint256).max;
    uint16  public constant MAX_FEE_BPS = 100; // hard cap: protocol fee can never exceed 1.00%

    /// @notice Protocol fee in basis points (1 bps = 0.01%). Taken from the input token.
    uint16 public feeBps = 10; // 0.10% default

    /// @notice Owner (deployer): can tune the fee and withdraw collected fees.
    address public owner;

    event Swapped(
        address indexed user,
        address indexed tokenIn,
        address indexed tokenOut,
        uint256 amountIn,
        uint256 amountOut,
        uint256 fee
    );
    event FeeUpdated(uint16 oldFeeBps, uint16 newFeeBps);
    event FeesWithdrawn(address indexed token, address indexed to, uint256 amount);
    event OwnerTransferred(address indexed oldOwner, address indexed newOwner);

    error NotOwner();
    error InvalidPair();
    error ZeroAmount();
    error FeeTooHigh();
    error TransferInFailed();
    error TransferOutFailed();
    error ZeroAddress();

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    constructor() {
        owner = msg.sender;
    }

    /// @dev Pool coin index for a supported token (USDC=0, EURC=1).
    function _indexOf(address token) private pure returns (int128) {
        if (token == USDC) return 0;
        if (token == EURC) return 1;
        revert InvalidPair();
    }

    /**
     * @notice Preview the output for a swap, net of the protocol fee.
     * @return amountOut Expected output (from the pool's own get_dy).
     * @return fee       Fee taken from the input token.
     */
    function quote(address tokenIn, address tokenOut, uint256 amountIn)
        external
        view
        returns (uint256 amountOut, uint256 fee)
    {
        if (tokenIn == tokenOut) revert InvalidPair();
        int128 i = _indexOf(tokenIn);
        int128 j = _indexOf(tokenOut);
        fee = (amountIn * feeBps) / 10_000;
        amountOut = ICurveStableSwap(POOL).get_dy(i, j, amountIn - fee);
    }

    /**
     * @notice Swap `amountIn` of `tokenIn` for `tokenOut` via the Curve pool.
     * @param minOut Minimum acceptable output (slippage floor, enforced by the pool).
     * @return amountOut Output tokens sent to the caller.
     */
    function swap(address tokenIn, address tokenOut, uint256 amountIn, uint256 minOut)
        external
        returns (uint256 amountOut)
    {
        if (amountIn == 0) revert ZeroAmount();
        if (tokenIn == tokenOut) revert InvalidPair();
        int128 i = _indexOf(tokenIn);
        int128 j = _indexOf(tokenOut);

        // Pull the input token from the caller.
        if (!IERC20(tokenIn).transferFrom(msg.sender, address(this), amountIn)) revert TransferInFailed();

        // Protocol fee stays in the router (withdrawable by the owner).
        uint256 fee = (amountIn * feeBps) / 10_000;
        uint256 swapAmount = amountIn - fee;

        // Approve the pool lazily (max once) so repeat swaps skip the approval.
        if (IERC20(tokenIn).allowance(address(this), POOL) < swapAmount) {
            IERC20(tokenIn).approve(POOL, MAX_UINT);
        }

        // Forward to Curve; the pool enforces `minOut` and sends output here.
        amountOut = ICurveStableSwap(POOL).exchange(i, j, swapAmount, minOut);

        // Forward the output to the caller.
        if (!IERC20(tokenOut).transfer(msg.sender, amountOut)) revert TransferOutFailed();

        emit Swapped(msg.sender, tokenIn, tokenOut, amountIn, amountOut, fee);
    }

    // ----------------------------- Admin -----------------------------

    /// @notice Update the protocol fee (basis points). Capped at MAX_FEE_BPS (1%).
    function setFee(uint16 newFeeBps) external onlyOwner {
        if (newFeeBps > MAX_FEE_BPS) revert FeeTooHigh();
        emit FeeUpdated(feeBps, newFeeBps);
        feeBps = newFeeBps;
    }

    /// @notice Withdraw collected fees (the router's full balance of `token`) to `to`.
    function withdrawFees(address token, address to) external onlyOwner {
        if (to == address(0)) revert ZeroAddress();
        uint256 bal = IERC20(token).balanceOf(address(this));
        if (!IERC20(token).transfer(to, bal)) revert TransferOutFailed();
        emit FeesWithdrawn(token, to, bal);
    }

    /// @notice Transfer ownership.
    function transferOwnership(address newOwner) external onlyOwner {
        if (newOwner == address(0)) revert ZeroAddress();
        emit OwnerTransferred(owner, newOwner);
        owner = newOwner;
    }
}
