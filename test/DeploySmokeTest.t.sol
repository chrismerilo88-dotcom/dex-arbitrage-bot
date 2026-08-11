// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

// Requires forge-std: run `forge install foundry-rs/forge-std` first.
import "forge-std/Test.sol";

import "../contracts/DexArbitrageBotFlashLoan.sol";
import "../contracts/adapters/UniswapV2Adapter.sol";
import "../contracts/libraries/RouteData.sol";
import "./helpers/RouteTestHelpers.sol";

/// @notice Run against a mainnet fork so every call below hits real Aave
/// and Uniswap contracts, not mocks:
///   forge test --match-contract DeploySmokeTest --fork-url $MAINNET_RPC_URL -vvv
///
/// This is a smoke test, not full coverage -- it checks that deployment,
/// the approval cooldown, and a V2 quote all behave as documented against
/// live contract state. It does NOT execute an actual flash loan (that
/// needs a real profitable opportunity to exist at fork time, which isn't
/// something a test can guarantee) -- see the comment on
/// test_RevertsBeforeCooldownElapses for how to extend this into a real
/// executeOperation() test using vm.warp.
contract DeploySmokeTest is Test {
    using RouteData for bytes;

    address constant WETH = 0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2;
    address constant USDC = 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48;
    address constant AAVE_ADDRESSES_PROVIDER = 0x2f39d218133AFaB8F2B819B1066c7E434Ad94E9e;
    address constant UNISWAP_V2_ROUTER = 0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D;

    DexArbitrageBotFlashLoan bot;
    UniswapV2Adapter v2Adapter;

    function setUp() public {
        bot = new DexArbitrageBotFlashLoan(AAVE_ADDRESSES_PROVIDER, WETH);
        v2Adapter = new UniswapV2Adapter(UNISWAP_V2_ROUTER);
    }

    function test_DeploysWithPoolResolved() public view {
        assertTrue(address(bot.POOL()) != address(0), "Aave pool should resolve from the addresses provider");
        assertEq(bot.WETH(), WETH);
        assertEq(bot.maxLoanAmount(), 0, "should start locked down");
        assertEq(bot.VERSION(), "v13");
    }

    function test_RevertsBeforeCooldownElapses() public {
        bot.approveAdapter(address(v2Adapter), true);
        bot.approveToken(WETH, true);
        bot.approveToken(USDC, true);
        bot.setMaxLoanAmount(10 ether);

        assertFalse(bot.isAdapterApproved(address(v2Adapter)), "should not be usable before the cooldown");

        bytes memory routeData1 = RouteData.encode(RouteTestHelpers.pair(WETH, USDC), "");
        bytes memory routeData2 = RouteData.encode(RouteTestHelpers.pair(USDC, WETH), "");

        vm.expectRevert(abi.encodeWithSelector(AdapterNotApproved.selector));
        bot.requestFlashLoanArbitrage(1 ether, address(v2Adapter), routeData1, address(v2Adapter), routeData2, 0, 300, 300, block.timestamp + 1 hours);

        // Warp past the default 24h cooldown and confirm it flips to usable.
        // This is the pattern to extend into a real executeOperation() test:
        // after this warp, a genuinely profitable routeData1/routeData2 pair
        // (found off-chain against this fork's actual reserves) would let
        // requestFlashLoanArbitrage succeed all the way through.
        vm.warp(block.timestamp + 24 hours + 1);
        assertTrue(bot.isAdapterApproved(address(v2Adapter)), "should be usable after the cooldown");
    }

    function test_V2AdapterQuoteMatchesRouterDirectly() public view {
        address[] memory path = RouteTestHelpers.pair(WETH, USDC);
        bytes memory routeData = RouteData.encode(path, "");

        uint256 viaAdapter = v2Adapter.quote(routeData, 1 ether);

        (bool ok, bytes memory ret) = UNISWAP_V2_ROUTER.staticcall(
            abi.encodeWithSignature("getAmountsOut(uint256,address[])", 1 ether, path)
        );
        require(ok, "router call failed");
        uint256[] memory amounts = abi.decode(ret, (uint256[]));

        assertEq(viaAdapter, amounts[amounts.length - 1], "adapter quote should match the router's own quote exactly");
    }
}
