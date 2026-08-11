// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

// Requires forge-std: run `forge install foundry-rs/forge-std` first.
import "forge-std/Test.sol";

import "../contracts/DexArbitrageBotFlashLoan.sol";
import "../contracts/adapters/UniswapV3Adapter.sol";
import "../contracts/libraries/RouteData.sol";
import "./helpers/RouteTestHelpers.sol";

/// @notice Run against a Base Sepolia fork so every call below hits real
/// Aave and Uniswap V3 contracts, not mocks:
///   forge test --match-contract BaseSepoliaSmokeTest --fork-url $BASE_SEPOLIA_RPC_URL -vvv
///
/// Mirrors DeploySmokeTest.t.sol's structure and scope (deployment, pool
/// resolution, approval cooldown) but targets the Base Sepolia / V3
/// adapter path exercised by DeployBaseSepolia.s.sol instead of the
/// mainnet / V2 path.
///
/// All four addresses below were confirmed live via `cast code` against
/// Base Sepolia directly (WETH via the OP-stack predeploy exception) --
/// see notes/03 - Address Registry.md for the verification log.
///
/// UNLIKE DeploySmokeTest, there is no test here equivalent to
/// test_V2AdapterQuoteMatchesRouterDirectly -- that needs a second real
/// token with confirmed live liquidity paired against WETH, and no such
/// token has been verified on Base Sepolia yet (see the caveat in
/// DeployBaseSepolia.s.sol). DUMMY_TOKEN below exists only to give
/// test_RevertsBeforeCooldownElapses structurally valid RouteData -- it
/// is not a real deployed contract and the call reverts on
/// AdapterNotApproved before RouteData is ever inspected. Once a real
/// token pair is confirmed via `cast code` (+ actual pool liquidity),
/// add a quote test here the same way DeploySmokeTest does for mainnet.
contract BaseSepoliaSmokeTest is Test {
    using RouteData for bytes;

    address constant WETH = 0x4200000000000000000000000000000000000006;
    address constant AAVE_ADDRESSES_PROVIDER = 0xE4C23309117Aa30342BFaae6c95c6478e0A4Ad00;
    address constant UNISWAP_V3_ROUTER02 = 0x94cC0AaC535CCDB3C01d6787D6413C739ae12bc4;
    address constant UNISWAP_V3_QUOTERV2 = 0xC5290058841028F1614F3A6F0F5816cAd0df5E27;

    // Not a real deployed token -- see contract-level comment above.
    address constant DUMMY_TOKEN = address(0x1234567890123456789012345678901234567890);

    DexArbitrageBotFlashLoan bot;
    UniswapV3Adapter v3Adapter;

    function setUp() public {
        bot = new DexArbitrageBotFlashLoan(AAVE_ADDRESSES_PROVIDER, WETH);
        v3Adapter = new UniswapV3Adapter(UNISWAP_V3_ROUTER02, UNISWAP_V3_QUOTERV2);
    }

    function test_DeploysWithPoolResolved() public view {
        assertTrue(address(bot.POOL()) != address(0), "Aave pool should resolve from the addresses provider");
        assertEq(bot.WETH(), WETH);
        assertEq(bot.maxLoanAmount(), 0, "should start locked down");
        assertEq(bot.VERSION(), "v13");
    }

    function test_RevertsBeforeCooldownElapses() public {
        bot.approveAdapter(address(v3Adapter), true);
        bot.approveToken(WETH, true);
        bot.setMaxLoanAmount(10 ether);

        assertFalse(bot.isAdapterApproved(address(v3Adapter)), "should not be usable before the cooldown");

        bytes memory routeData1 = RouteData.encode(RouteTestHelpers.pair(WETH, DUMMY_TOKEN), abi.encode(_fees()));
        bytes memory routeData2 = RouteData.encode(RouteTestHelpers.pair(DUMMY_TOKEN, WETH), abi.encode(_fees()));

        vm.expectRevert(abi.encodeWithSelector(AdapterNotApproved.selector));
        bot.requestFlashLoanArbitrage(
            1 ether, address(v3Adapter), routeData1, address(v3Adapter), routeData2, 0, 300, 300, block.timestamp + 1 hours
        );

        // Warp past the default 24h cooldown and confirm it flips to usable.
        vm.warp(block.timestamp + 24 hours + 1);
        assertTrue(bot.isAdapterApproved(address(v3Adapter)), "should be usable after the cooldown");
    }

    function _fees() internal pure returns (uint24[] memory fees) {
        fees = new uint24[](1);
        fees[0] = 3000;
    }
}
