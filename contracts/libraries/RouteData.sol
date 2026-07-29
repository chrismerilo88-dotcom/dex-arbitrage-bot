// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

/// @notice Shared route-encoding convention every adapter and the executor
/// agree on: routeData = abi.encode(address[] tokens, bytes extra).
///
/// `tokens` is the ordered list of tokens the route touches -- the
/// executor decodes just this part for allowlist checks and to find the
/// route's start/end tokens, without needing to understand any
/// protocol-specific format.
///
/// `extra` carries whatever additional data a specific adapter needs (V3
/// per-hop fee tiers, a Curve pool address and coin indices, a Balancer
/// pool ID, or nothing at all for plain V2) and is opaque to everyone
/// except that adapter.
library RouteData {
    function encode(address[] memory tokens, bytes memory extra) internal pure returns (bytes memory) {
        return abi.encode(tokens, extra);
    }

    /// @dev Declared with a `memory` parameter rather than `calldata` so
    /// this single function works whether called with an actual calldata
    /// argument (Solidity copies it to memory automatically at the call
    /// site) or an already-in-memory one (e.g. after abi.decode inside
    /// executeOperation) -- no need for two near-identical overloads.
    function decode(bytes memory routeData) internal pure returns (address[] memory tokens, bytes memory extra) {
        (tokens, extra) = abi.decode(routeData, (address[], bytes));
    }
}
