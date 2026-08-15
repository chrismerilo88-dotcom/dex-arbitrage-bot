// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import "../interfaces/IDexAdapter.sol";
import "../interfaces/IERC20Min.sol";
import "../libraries/RouteData.sol";
import "../libraries/SafeERC20.sol";
import "../libraries/CommonErrors.sol";

/// @dev Camelot's real, live-verified Arbitrum router
/// (0xc873fecbd354f5a56e00e710b90ef4201db2448d) does NOT expose the
/// classic Uniswap V2 swapExactTokensForTokens(uint256,uint256,address[],
/// address,uint256) -- confirmed absent from its deployed bytecode via
/// cast sig + cast code before writing this file, same discipline that
/// caught PancakeSwap's V3 router interface mismatch. getAmountsOut has
/// the classic signature (confirmed present), which is what made this an
/// easy-to-miss bug: quote() would have looked like it worked while
/// swap() reverted on every real trade. Camelot's only swap entrypoint
/// is the fee-on-transfer-supporting variant, with an extra `referrer`
/// address before `deadline` (confirmed present: selector 0xac3893ba
/// matches swapExactTokensForTokensSupportingFeeOnTransferTokens(uint256,
/// uint256,address[],address,address,uint256)) -- this adapter passes
/// address(0) (no referrer relationship).
interface ICamelotRouter {
    function getAmountsOut(uint256 amountIn, address[] calldata path) external view returns (uint256[] memory amounts);

    function swapExactTokensForTokensSupportingFeeOnTransferTokens(
        uint256 amountIn,
        uint256 amountOutMin,
        address[] calldata path,
        address to,
        address referrer,
        uint256 deadline
    ) external;
}

/// @notice Wraps Camelot's V2 AMM router behind the common IDexAdapter
/// interface. Deploy one instance pointed at Camelot's router; approve
/// *this adapter's* address in the executor, not the router's.
/// routeData's `extra` field is unused, same as UniswapV2Adapter.
///
/// swap() measures the actual amount received via balance delta rather
/// than trusting a return value, because the fee-on-transfer-supporting
/// function this router requires doesn't return one at all (by design --
/// the real output isn't knowable ahead of the transfer for a token that
/// might take a fee on it). Same reasoning as the executor's own
/// _executeRoute(), and correct for the same reason: works regardless of
/// whether the output token itself charges a transfer fee.
contract CamelotV2Adapter is IDexAdapter {
    using SafeERC20 for address;
    using RouteData for bytes;

    ICamelotRouter public immutable ROUTER;

    constructor(address router) {
        if (router == address(0)) revert ZeroAddress();
        ROUTER = ICamelotRouter(router);
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
        address tokenOut = tokens[tokens.length - 1];

        tokenIn.safeTransferFrom(msg.sender, address(this), amountIn);
        tokenIn.safeApprove(address(ROUTER), amountIn);

        uint256 balBefore = IERC20Min(tokenOut).balanceOf(recipient);
        ROUTER.swapExactTokensForTokensSupportingFeeOnTransferTokens(
            amountIn, minAmountOut, tokens, recipient, address(0), deadline
        );
        amountOut = IERC20Min(tokenOut).balanceOf(recipient) - balBefore;
    }
}
