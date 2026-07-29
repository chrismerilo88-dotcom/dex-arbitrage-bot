// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

/// @notice Common interface every DEX-specific adapter implements, so the
/// executor contract can treat Uniswap V2, V3, Curve, and Balancer routes
/// uniformly instead of hardcoding one protocol's router interface. See
/// RouteData.sol for the shared routeData encoding every adapter agrees on.
///
/// One adapter instance wraps one underlying router/pool/vault. Deploy an
/// adapter per concrete DEX you want to use (e.g. a UniswapV2Adapter
/// pointed at Uniswap's router, another instance pointed at SushiSwap's),
/// then approve each adapter's own address in the executor -- not the
/// underlying protocol's address.
interface IDexAdapter {
    /// @notice Quotes amountOut for amountIn along routeData, without
    /// moving funds.
    /// @dev Deliberately NOT declared view: Uniswap V3's on-chain quoter
    /// needs write access internally to simulate a swap, and is only
    /// gas-cheap when called off-chain via eth_call, which works
    /// regardless of a function's declared mutability. Adapters that can
    /// stay pure view internally (V2, most Curve pools) still satisfy
    /// this signature -- Solidity allows overriding an interface function
    /// with a stricter mutability (e.g. view) than the interface declares.
    function quote(bytes calldata routeData, uint256 amountIn) external returns (uint256 amountOut);

    /// @notice Pulls amountIn of routeData's first token from msg.sender
    /// (which must have approved this adapter first), executes the swap
    /// however this protocol requires, and delivers at least
    /// minAmountOut of routeData's last token to `recipient`. Reverts if
    /// that minimum isn't met.
    function swap(
        bytes calldata routeData,
        uint256 amountIn,
        uint256 minAmountOut,
        address recipient,
        uint256 deadline
    ) external returns (uint256 amountOut);
}
