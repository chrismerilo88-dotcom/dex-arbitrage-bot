// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import "../interfaces/IDexAdapter.sol";
import "../libraries/RouteData.sol";
import "../libraries/SafeERC20.sol";
import "../libraries/CommonErrors.sol";

interface ICurvePool {
    function get_dy(int128 i, int128 j, uint256 dx) external view returns (uint256);
    function exchange(int128 i, int128 j, uint256 dx, uint256 min_dy) external returns (uint256);
    function coins(uint256 index) external view returns (address);
}

error CoinIndexMismatch();

/// @notice Wraps a single Curve pool's exchange() behind IDexAdapter.
///
/// SCOPE LIMIT: exactly one pool, two tokens per leg. Curve's pool
/// interfaces vary too much across stable/crypto/metapool variants to
/// generalize further here -- tokens.length must be exactly 2.
///
/// routeData's `extra` field is abi.encode(int128 i, int128 j): the
/// pool's own coin indices for tokens[0] and tokens[1] respectively.
/// Both quote() and swap() verify coins(i) == tokens[0] and
/// coins(j) == tokens[1] on-chain (reverts with CoinIndexMismatch if
/// not) -- this is what actually binds the executor's token allowlist
/// (checked against `tokens`, not `extra`) to what the pool trades,
/// since `tokens` doesn't otherwise determine the swap direction here.
///
/// CAUTION: this interface (int128 indices, exchange/get_dy names)
/// matches Curve's classic stable-pool style (e.g. 3pool). Newer crypto
/// and metapool variants commonly use different signatures (uint256
/// indices, different function names) and are NOT compatible with this
/// adapter -- deploying against a mismatched pool will revert, or in the
/// worst case silently misbehave if the ABI happens to partially match.
/// Verify the target pool's actual interface before deploying an adapter
/// instance for it.
///
/// Curve's classic exchange() also has no recipient or deadline
/// parameter -- swapped output lands in this adapter first and is then
/// forwarded, and the `deadline` argument to swap() below is accepted
/// for interface consistency but not enforced by the pool itself.
/// Overall request staleness is still bounded by the executor's own
/// executeBefore check, independent of this.
contract CurveAdapter is IDexAdapter {
    using SafeERC20 for address;
    using RouteData for bytes;

    ICurvePool public immutable POOL;

    constructor(address pool) {
        if (pool == address(0)) revert ZeroAddress();
        POOL = ICurvePool(pool);
    }

    function quote(bytes calldata routeData, uint256 amountIn) external view override returns (uint256 amountOut) {
        (address[] memory tokens, bytes memory extra) = routeData.decode();
        if (tokens.length != 2) revert UnsupportedRoute();
        (int128 i, int128 j) = abi.decode(extra, (int128, int128));
        _requireIndicesMatch(tokens, i, j);
        amountOut = POOL.get_dy(i, j, amountIn);
    }

    function swap(
        bytes calldata routeData,
        uint256 amountIn,
        uint256 minAmountOut,
        address recipient,
        uint256 /* deadline */
    ) external override returns (uint256 amountOut) {
        (address[] memory tokens, bytes memory extra) = routeData.decode();
        if (tokens.length != 2) revert UnsupportedRoute();
        (int128 i, int128 j) = abi.decode(extra, (int128, int128));
        _requireIndicesMatch(tokens, i, j);

        address tokenIn = tokens[0];
        address tokenOut = tokens[1];

        tokenIn.safeTransferFrom(msg.sender, address(this), amountIn);
        tokenIn.safeApprove(address(POOL), amountIn);

        amountOut = POOL.exchange(i, j, amountIn, minAmountOut);

        if (recipient != address(this)) {
            tokenOut.safeTransfer(recipient, amountOut);
        }
    }

    /// @dev Binds the pool's own coin indices to the executor-allowlisted
    /// `tokens` array -- without this, `tokens` plays no role in which
    /// coins actually trade, so the executor's per-token allowlist check
    /// (against `tokens`, not `extra`) wouldn't actually constrain
    /// anything for Curve routes.
    function _requireIndicesMatch(address[] memory tokens, int128 i, int128 j) internal view {
        if (i < 0 || j < 0) revert CoinIndexMismatch();
        // casting to 'uint128' is safe because the non-negative check above
        // already reverted on any value this cast could otherwise misread.
        // forge-lint: disable-next-line(unsafe-typecast)
        if (POOL.coins(uint256(uint128(i))) != tokens[0]) revert CoinIndexMismatch();
        // forge-lint: disable-next-line(unsafe-typecast)
        if (POOL.coins(uint256(uint128(j))) != tokens[1]) revert CoinIndexMismatch();
    }
}
