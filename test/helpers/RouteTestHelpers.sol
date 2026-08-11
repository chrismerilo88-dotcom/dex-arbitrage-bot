// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

/// @notice Shared route-building helpers for tests, so each test file
/// doesn't redeclare the same tiny array builders. Mirrors the pattern
/// used in contracts/libraries/CommonErrors.sol for the same reason --
/// see the "New in v12" changelog entry in DexArbitrageBotFlashLoan.sol
/// for why duplicated declarations across files are worth avoiding here.
library RouteTestHelpers {
    function pair(address a, address b) internal pure returns (address[] memory path) {
        path = new address[](2);
        path[0] = a;
        path[1] = b;
    }
}
