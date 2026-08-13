// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import "../interfaces/IDexAdapter.sol";
import "../libraries/RouteData.sol";
import "../libraries/SafeERC20.sol";
import "../libraries/CommonErrors.sol";

/// @dev The ORIGINAL v3-periphery ISwapRouter interface (deadline
/// included in the structs), NOT SwapRouter02's IV3SwapRouter -- see
/// UniswapV3Adapter.sol's own doc comment for the full story of why that
/// distinction matters and how getting it wrong went undetected there.
/// PancakeSwap V3's real deployed SwapRouter (BNB Chain, verified live
/// via cast selectors against its actual bytecode, not assumed from its
/// name or from being "a Uniswap V3 fork") still uses this original
/// shape -- selectors 0x414bf389/0xc04b8d59, exactly the ones
/// UniswapV3Adapter.sol's own header names as the WRONG ones for
/// SwapRouter02. Two genuinely different, real interfaces in the wild
/// for "a Uniswap V3-style router" -- this file exists for the routers
/// that kept the original one, UniswapV3Adapter.sol for the ones that
/// moved to SwapRouter02's.
interface ISwapRouter {
    struct ExactInputSingleParams {
        address tokenIn;
        address tokenOut;
        uint24 fee;
        address recipient;
        uint256 deadline;
        uint256 amountIn;
        uint256 amountOutMinimum;
        uint160 sqrtPriceLimitX96;
    }

    function exactInputSingle(ExactInputSingleParams calldata params) external payable returns (uint256 amountOut);

    struct ExactInputParams {
        bytes path;
        address recipient;
        uint256 deadline;
        uint256 amountIn;
        uint256 amountOutMinimum;
    }

    function exactInput(ExactInputParams calldata params) external payable returns (uint256 amountOut);
}

/// @dev Same QuoterV2 shape as UniswapV3Adapter.sol -- verified live via
/// cast selectors against PancakeSwap's real deployed QuoterV2 bytecode:
/// unlike the router, the quoter side genuinely does match (both
/// quoteExactInputSingle and quoteExactInput selectors present).
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

/// @notice Wraps a PancakeSwap V3-style SwapRouter (original ISwapRouter
/// interface, with deadline) + QuoterV2 pair behind the common
/// IDexAdapter interface. Otherwise identical to UniswapV3Adapter.sol --
/// see that file for the shared design notes (routeData encoding,
/// multi-hop path format, QuoterV2's gas-cost caveat).
///
/// Unlike UniswapV3Adapter.sol, this one actually uses the `deadline`
/// parameter IDexAdapter.swap() already carries -- the original
/// ISwapRouter interface has a slot for it, so there's no reason to
/// discard it the way SwapRouter02's interface (which has none) forces.
contract PancakeV3Adapter is IDexAdapter {
    using SafeERC20 for address;
    using RouteData for bytes;

    ISwapRouter public immutable ROUTER;
    IQuoterV2 public immutable QUOTER;

    constructor(address router, address quoter) {
        if (router == address(0) || quoter == address(0)) revert ZeroAddress();
        ROUTER = ISwapRouter(router);
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

    function swap(
        bytes calldata routeData,
        uint256 amountIn,
        uint256 minAmountOut,
        address recipient,
        uint256 deadline
    ) external override returns (uint256 amountOut) {
        (address[] memory tokens, bytes memory extra) = routeData.decode();
        uint24[] memory fees = abi.decode(extra, (uint24[]));
        if (fees.length != tokens.length - 1) revert FeeTierCountMismatch();

        address tokenIn = tokens[0];
        tokenIn.safeTransferFrom(msg.sender, address(this), amountIn);
        tokenIn.safeApprove(address(ROUTER), amountIn);

        if (tokens.length == 2) {
            amountOut = ROUTER.exactInputSingle(
                ISwapRouter.ExactInputSingleParams({
                    tokenIn: tokenIn,
                    tokenOut: tokens[1],
                    fee: fees[0],
                    recipient: recipient,
                    deadline: deadline,
                    amountIn: amountIn,
                    amountOutMinimum: minAmountOut,
                    sqrtPriceLimitX96: 0
                })
            );
        } else {
            amountOut = ROUTER.exactInput(
                ISwapRouter.ExactInputParams({
                    path: _encodePath(tokens, fees),
                    recipient: recipient,
                    deadline: deadline,
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
