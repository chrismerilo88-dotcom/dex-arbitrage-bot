// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import "../interfaces/IDexAdapter.sol";
import "../libraries/RouteData.sol";
import "../libraries/SafeERC20.sol";
import "../libraries/CommonErrors.sol";

interface IUniswapV2Router02 {
    function getAmountsOut(uint amountIn, address[] calldata path)
        external
        view
        returns (uint[] memory amounts);

    function swapExactTokensForTokens(
        uint amountIn,
        uint amountOutMin,
        address[] calldata path,
        address to,
        uint deadline
    ) external returns (uint[] memory amounts);
}

/// @notice Wraps a single Uniswap V2 (or fork) router behind the common
/// IDexAdapter interface. Deploy one instance per router -- Uniswap,
/// SushiSwap, PancakeSwap V2, etc. -- and approve *this adapter's*
/// address in the executor contract, not the underlying router's.
/// routeData's `extra` field is unused; `tokens` alone is the swap path,
/// exactly as it was passed directly in the pre-adapter version of the
/// executor.
contract UniswapV2Adapter is IDexAdapter {
    using SafeERC20 for address;
    using RouteData for bytes;

    IUniswapV2Router02 public immutable ROUTER;

    constructor(address router) {
        if (router == address(0)) revert ZeroAddress();
        ROUTER = IUniswapV2Router02(router);
    }

    function quote(bytes calldata routeData, uint256 amountIn) external view override returns (uint256 amountOut) {
        (address[] memory tokens, ) = routeData.decode();
        uint256[] memory amounts = ROUTER.getAmountsOut(amountIn, tokens);
        amountOut = amounts[amounts.length - 1];
    }

    function swap(
        bytes calldata routeData,
        uint256 amountIn,
        uint256 minAmountOut,
        address recipient,
        uint256 deadline
    ) external override returns (uint256 amountOut) {
        (address[] memory tokens, ) = routeData.decode();
        address tokenIn = tokens[0];

        tokenIn.safeTransferFrom(msg.sender, address(this), amountIn);
        tokenIn.safeApprove(address(ROUTER), amountIn);

        uint256[] memory amounts =
            ROUTER.swapExactTokensForTokens(amountIn, minAmountOut, tokens, recipient, deadline);
        amountOut = amounts[amounts.length - 1];
    }
}
