// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

/// @notice Minimal ERC20 interface used only by adapters, which just need
/// transferFrom to pull funds from the executor. Kept separate from the
/// executor's own IERC20 (which also needs balanceOf/allowance) so each
/// side only imports what it actually uses.
interface IERC20Min {
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
}
