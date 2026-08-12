// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import "../interfaces/IDexAdapter.sol";
import "../libraries/RouteData.sol";
import "../libraries/SafeERC20.sol";
import "../libraries/CommonErrors.sol";

/// @dev SwapRouter02's IV3SwapRouter -- NOT the original v3-periphery
/// ISwapRouter. SwapRouter02 dropped `deadline` from these structs
/// (it handles deadlines via `multicall(uint256 deadline, bytes[])`
/// instead), which changes the function selectors entirely. Every
/// router address in notes/03 - Address Registry.md is SwapRouter02,
/// confirmed by checking the deployed bytecode directly for these exact
/// selectors -- see notes/03 for the full writeup of how the original
/// (wrong) interface here went undetected: quote() uses QuoterV2, whose
/// selectors are unaffected by this, so quoting always worked while
/// swap() would have reverted on selector mismatch for every real trade.
interface IV3SwapRouter {
    struct ExactInputSingleParams {
        address tokenIn;
        address tokenOut;
        uint24 fee;
        address recipient;
        uint256 amountIn;
        uint256 amountOutMinimum;
        uint160 sqrtPriceLimitX96;
    }

    function exactInputSingle(ExactInputSingleParams calldata params) external payable returns (uint256 amountOut);

    struct ExactInputParams {
        bytes path;
        address recipient;
        uint256 amountIn;
        uint256 amountOutMinimum;
    }

    function exactInput(ExactInputParams calldata params) external payable returns (uint256 amountOut);
}

interface IQuoterV2 {
    struct QuoteExactInputSingleParams {
        address tokenIn;
        address tokenOut;
        uint256 amountIn;
        uint24 fee;
        uint160 sqrtPriceLimitX96;
    }

    function quoteExactInputSingle(QuoteExactInputSingleParams memory params)
        external
        returns (uint256 amountOut, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate);

    function quoteExactInput(bytes memory path, uint256 amountIn)
        external
        returns (
            uint256 amountOut,
            uint160[] memory sqrtPriceX96AfterList,
            uint32[] memory initializedTicksCrossedList,
            uint256 gasEstimate
        );
}

error FeeTierCountMismatch();

/// @notice Wraps a Uniswap V3 SwapRouter + QuoterV2 pair behind the common
/// IDexAdapter interface. Supports single-hop and multi-hop paths.
///
/// routeData's `extra` field is abi.encode(uint24[] fees), one fee tier
/// per hop -- fees.length must equal tokens.length - 1. E.g. [3000] for a
/// single 0.3% pool, or [3000, 500] for a two-hop route through a 0.3%
/// pool then a 0.05% pool.
///
/// CAUTION: QuoterV2's on-chain quote() genuinely simulates a swap
/// internally and is gas-expensive -- that's expected, standard behavior
/// for V3 quoting, not a bug here. If quoteRoute() on the executor is
/// ever called from another on-chain contract expecting a cheap read, a
/// V3 leg will make that call far more expensive than a V2 leg would.
/// Off-chain callers using eth_call don't pay real gas for this either way.
contract UniswapV3Adapter is IDexAdapter {
    using SafeERC20 for address;
    using RouteData for bytes;

    IV3SwapRouter public immutable ROUTER;
    IQuoterV2 public immutable QUOTER;

    constructor(address router, address quoter) {
        if (router == address(0) || quoter == address(0)) revert ZeroAddress();
        ROUTER = IV3SwapRouter(router);
        QUOTER = IQuoterV2(quoter);
    }

    function quote(bytes calldata routeData, uint256 amountIn) external override returns (uint256 amountOut) {
        (address[] memory tokens, bytes memory extra) = routeData.decode();
        uint24[] memory fees = abi.decode(extra, (uint24[]));
        if (fees.length != tokens.length - 1) revert FeeTierCountMismatch();

        if (tokens.length == 2) {
            (amountOut, , , ) = QUOTER.quoteExactInputSingle(
                IQuoterV2.QuoteExactInputSingleParams({
                    tokenIn: tokens[0],
                    tokenOut: tokens[1],
                    amountIn: amountIn,
                    fee: fees[0],
                    sqrtPriceLimitX96: 0
                })
            );
        } else {
            (amountOut, , , ) = QUOTER.quoteExactInput(_encodePath(tokens, fees), amountIn);
        }
    }

    /// @dev `deadline` is part of IDexAdapter's shared signature (V2 uses it
    /// directly) but SwapRouter02 has no per-call deadline param -- staleness
    /// is already bounded by the executor's own `executeBefore` check before
    /// any adapter is ever reached, so it's intentionally unused here.
    function swap(
        bytes calldata routeData,
        uint256 amountIn,
        uint256 minAmountOut,
        address recipient,
        uint256 /* deadline */
    ) external override returns (uint256 amountOut) {
        (address[] memory tokens, bytes memory extra) = routeData.decode();
        uint24[] memory fees = abi.decode(extra, (uint24[]));
        if (fees.length != tokens.length - 1) revert FeeTierCountMismatch();

        address tokenIn = tokens[0];
        tokenIn.safeTransferFrom(msg.sender, address(this), amountIn);
        tokenIn.safeApprove(address(ROUTER), amountIn);

        if (tokens.length == 2) {
            amountOut = ROUTER.exactInputSingle(
                IV3SwapRouter.ExactInputSingleParams({
                    tokenIn: tokenIn,
                    tokenOut: tokens[1],
                    fee: fees[0],
                    recipient: recipient,
                    amountIn: amountIn,
                    amountOutMinimum: minAmountOut,
                    sqrtPriceLimitX96: 0
                })
            );
        } else {
            amountOut = ROUTER.exactInput(
                IV3SwapRouter.ExactInputParams({
                    path: _encodePath(tokens, fees),
                    recipient: recipient,
                    amountIn: amountIn,
                    amountOutMinimum: minAmountOut
                })
            );
        }
    }

    /// @dev Builds V3's packed path format: token0 | fee0 (3 bytes) |
    /// token1 | fee1 (3 bytes) | token2 | ...
    function _encodePath(address[] memory tokens, uint24[] memory fees) internal pure returns (bytes memory path) {
        path = abi.encodePacked(tokens[0]);
        for (uint256 i = 0; i < fees.length; i++) {
            path = abi.encodePacked(path, fees[i], tokens[i + 1]);
        }
    }
}
