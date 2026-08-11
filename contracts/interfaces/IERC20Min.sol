// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

/// @notice Minimal ERC20 interface used only by adapters that need more
/// than a bare transferFrom -- e.g. measuring output via balance delta
/// instead of trusting a pool's return value. Kept separate from the
/// executor's own IERC20 (which also needs allowance) so each side only
/// imports what it actually uses.
interface IERC20Min {
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
}
