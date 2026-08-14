// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import "forge-std/Test.sol";

import "../contracts/DexArbitrageBotFlashLoan.sol";
import "../contracts/interfaces/IDexAdapter.sol";
import "../contracts/libraries/RouteData.sol";
import "./helpers/RouteTestHelpers.sol";

/// @notice Minimal mintable ERC20 -- no external dependency (OpenZeppelin/
/// solmate aren't installed here). Same reasoning as this project's other
/// small reimplementations (e.g. v3SwapAmountOut() in off-chain-bot/lib.js
/// instead of pulling in Uniswap's own v3-sdk package): this is one
/// well-understood, ~20-line piece, not worth a dependency.
contract MockERC20 {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        _transfer(msg.sender, to, amount);
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        uint256 allowed = allowance[from][msg.sender];
        require(allowed >= amount, "MockERC20: allowance");
        allowance[from][msg.sender] = allowed - amount;
        _transfer(from, to, amount);
        return true;
    }

    function _transfer(address from, address to, uint256 amount) internal {
        require(balanceOf[from] >= amount, "MockERC20: balance");
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
    }
}

contract MockPoolAddressesProvider {
    address public pool;

    constructor(address _pool) {
        pool = _pool;
    }

    function getPool() external view returns (address) {
        return pool;
    }
}

/// @notice Stands in for Aave's real Pool for flashLoanSimple(): mints
/// `amount` of the requested asset straight to the receiver (Aave's real
/// pool transfers from its own liquidity; minting is equivalent here
/// since only the flash-loan callback CONTRACT's behavior is under test,
/// not Aave itself), calls back into executeOperation() exactly like the
/// real pool does, then pulls back amount+premium via the approval
/// executeOperation() must have granted by the time it returns --
/// reverting if that pull fails, same as a real flash loan settling.
contract MockFlashLoanPool {
    uint128 public premiumBps;

    constructor(uint128 _premiumBps) {
        premiumBps = _premiumBps;
    }

    function FLASHLOAN_PREMIUM_TOTAL() external view returns (uint128) {
        return premiumBps;
    }

    function flashLoanSimple(
        address receiverAddress,
        address asset,
        uint256 amount,
        bytes calldata params,
        uint16 /* referralCode */
    ) external {
        uint256 premium = (amount * premiumBps) / 10000;
        MockERC20(asset).mint(receiverAddress, amount);
        bool ok = IFlashLoanSimpleReceiver(receiverAddress).executeOperation(asset, amount, premium, receiverAddress, params);
        require(ok, "MockFlashLoanPool: executeOperation returned false");
        MockERC20(asset).transferFrom(receiverAddress, address(this), amount + premium);
    }
}

/// @notice Stands in for one DEX leg: quote() and swap() both return the
/// same configured `output` regardless of routeData/amountIn --
/// deliberately, so this isolates the fuzz test below to
/// executeOperation()'s profit-floor arithmetic itself, not any
/// particular DEX's pricing curve (already covered separately by
/// lib.js's own v3SwapAmountOut()/applyHopPrice() tests and the
/// fork-based smoke tests against real pools). swap() pulls amountIn of
/// the input token from msg.sender (the executor, which approves this
/// adapter first, same as a real one) and mints the configured output
/// directly to recipient.
contract MockDexAdapter is IDexAdapter {
    uint256 public immutable output;

    constructor(uint256 _output) {
        output = _output;
    }

    function quote(bytes calldata, uint256) external view returns (uint256) {
        return output;
    }

    function swap(
        bytes calldata routeData,
        uint256 amountIn,
        uint256 minAmountOut,
        address recipient,
        uint256 /* deadline */
    ) external returns (uint256) {
        require(output >= minAmountOut, "MockDexAdapter: below minAmountOut");
        (address[] memory tokens, ) = RouteData.decode(routeData);
        MockERC20(tokens[0]).transferFrom(msg.sender, address(this), amountIn);
        MockERC20(tokens[tokens.length - 1]).mint(recipient, output);
        return output;
    }
}

/// @notice Property test for the one guarantee this whole project's
/// safety claim rests on (see "the one sentence that matters most" in
/// notes/00 - Project Overview.md): the contract cannot knowingly
/// execute a trade that loses money. The example-based fork tests
/// (DeploySmokeTest.t.sol / BaseSepoliaSmokeTest.t.sol) prove this holds
/// for a handful of hand-picked real-world scenarios; this fuzzes
/// amount/premium/leg-outputs/minProfit across a wide range instead, so
/// the invariant is checked against everything Foundry's fuzzer
/// generates, not just what a human thought to write down.
///
/// Deliberately out of scope here: the WETH-specific gas-cost backstop
/// (item 21 in the contract's header, ProfitBelowGasCost) -- this test's
/// borrowed asset is never configured as WETH, specifically to keep that
/// separate, real-gas-usage-dependent check from adding noise to what's
/// otherwise a clean arithmetic property. Worth its own fuzz test later.
contract DexArbitrageBotFlashLoanFuzzTest is Test {
    function testFuzz_ExecuteOperation_NeverPaysOutBelowMinProfit(
        uint256 amount,
        uint16 premiumBps,
        uint256 leg1Out,
        uint256 leg2Out,
        uint256 minProfit
    ) public {
        amount = bound(amount, 1e6, 1e30);
        premiumBps = uint16(bound(premiumBps, 0, 1000)); // 0-10%; Aave's real premium is far lower, bounded wide for margin
        leg1Out = bound(leg1Out, 1, 1e30); // never 0 -- 0 here would just retest NoViableRoute(), not this invariant
        leg2Out = bound(leg2Out, 0, 1e30); // 0 allowed: exercises the "route returns nothing" edge alongside underwater/profitable cases
        minProfit = bound(minProfit, 0, 1e30);

        MockERC20 borrowedAsset = new MockERC20();
        MockERC20 midToken = new MockERC20();
        MockERC20 wethStandIn = new MockERC20(); // distinct from borrowedAsset -- see contract-level doc comment
        MockFlashLoanPool pool = new MockFlashLoanPool(premiumBps);
        MockPoolAddressesProvider addressesProvider = new MockPoolAddressesProvider(address(pool));
        DexArbitrageBotFlashLoan bot = new DexArbitrageBotFlashLoan(address(addressesProvider), address(wethStandIn));

        MockDexAdapter adapter1 = new MockDexAdapter(leg1Out);
        MockDexAdapter adapter2 = new MockDexAdapter(leg2Out);

        // address(this) is bot's owner (deployer) -- no vm.prank needed,
        // same pattern as DexArbitrageBotFlashLoanUnit.t.sol.
        bot.setApprovalDelay(0);
        bot.approveAdapter(address(adapter1), true);
        bot.approveAdapter(address(adapter2), true);
        bot.approveToken(address(borrowedAsset), true);
        bot.approveToken(address(midToken), true);
        bot.setMaxLoanAmount(amount);

        bytes memory routeData1 = RouteData.encode(RouteTestHelpers.pair(address(borrowedAsset), address(midToken)), "");
        bytes memory routeData2 = RouteData.encode(RouteTestHelpers.pair(address(midToken), address(borrowedAsset)), "");

        uint256 premium = (amount * premiumBps) / 10000;
        uint256 amountOwed = amount + premium;
        uint256 ownerBalanceBefore = borrowedAsset.balanceOf(address(this));

        // slippageBps = 0: MockDexAdapter's quote() and swap() always
        // return the identical `output`, so the slippage bound never
        // trips regardless of value -- isolates this test to the
        // profit-floor logic alone, not slippage handling (already
        // covered by test_Request_RevertsWhenSlippageTooHigh() etc. in
        // the unit suite).
        if (leg2Out <= amountOwed || leg2Out - amountOwed < minProfit) {
            vm.expectRevert();
            bot.requestFlashLoanArbitrage(
                amount, address(adapter1), routeData1, address(adapter2), routeData2, minProfit, 0, 3600, block.timestamp + 1 hours
            );
        } else {
            bot.requestFlashLoanArbitrage(
                amount, address(adapter1), routeData1, address(adapter2), routeData2, minProfit, 0, 3600, block.timestamp + 1 hours
            );
            uint256 expectedProfit = leg2Out - amountOwed;
            assertEq(
                borrowedAsset.balanceOf(address(this)) - ownerBalanceBefore,
                expectedProfit,
                "owner did not receive exactly the realized profit"
            );
            assertGe(expectedProfit, minProfit, "invariant violated: profit below minProfit yet the call succeeded");
        }
    }

    /// @notice Companion to the test above, covering the one profit-floor
    /// path that one deliberately left untested: the WETH-specific gas
    /// backstop (ProfitBelowGasCost, item 21 in the contract's header).
    /// gasCostWei depends on real, measured gas usage inside
    /// executeOperation() (gasStart - gasleft()) times tx.gasprice, which
    /// this test can't predict exactly from the outside without
    /// duplicating the EVM's own gas accounting -- so rather than fuzz
    /// the exact revert/success boundary (fragile, and not the
    /// interesting property anyway), this fuzzes tx.gasprice across a
    /// wide range and checks the two ends that ARE robust to unknown
    /// exact gas usage: a dust-sized (1 wei) profit can never slip past
    /// the backstop, and a clearly-enormous profit is never blocked by
    /// it.
    function testFuzz_ExecuteOperation_WethGasBackstop(uint256 amount, uint16 premiumBps, uint256 leg1Out, uint256 gasPriceWei, bool profitable) public {
        amount = bound(amount, 1e6, 1e24);
        premiumBps = uint16(bound(premiumBps, 0, 1000));
        leg1Out = bound(leg1Out, 1, 1e24);
        gasPriceWei = bound(gasPriceWei, 1, 500 gwei);
        vm.txGasPrice(gasPriceWei);

        MockERC20 borrowedAsset = new MockERC20();
        MockERC20 midToken = new MockERC20();
        MockFlashLoanPool pool = new MockFlashLoanPool(premiumBps);
        MockPoolAddressesProvider addressesProvider = new MockPoolAddressesProvider(address(pool));
        // borrowedAsset IS WETH here (unlike the test above) -- the whole
        // point is exercising the asset == WETH branch.
        DexArbitrageBotFlashLoan bot = new DexArbitrageBotFlashLoan(address(addressesProvider), address(borrowedAsset));

        uint256 premium = (amount * premiumBps) / 10000;
        uint256 amountOwed = amount + premium;
        // +1 wei (dust, virtually certain to lose to any real gas cost) or
        // +1e24 (enormous, virtually certain to clear any real gas cost)
        // -- see the doc comment above for why the exact boundary itself
        // isn't fuzzed.
        uint256 leg2Out = profitable ? amountOwed + 1e24 : amountOwed + 1;

        MockDexAdapter adapter1 = new MockDexAdapter(leg1Out);
        MockDexAdapter adapter2 = new MockDexAdapter(leg2Out);

        bot.setApprovalDelay(0);
        bot.approveAdapter(address(adapter1), true);
        bot.approveAdapter(address(adapter2), true);
        bot.approveToken(address(borrowedAsset), true);
        bot.approveToken(address(midToken), true);
        bot.setMaxLoanAmount(amount);

        bytes memory routeData1 = RouteData.encode(RouteTestHelpers.pair(address(borrowedAsset), address(midToken)), "");
        bytes memory routeData2 = RouteData.encode(RouteTestHelpers.pair(address(midToken), address(borrowedAsset)), "");
        uint256 ownerBalanceBefore = borrowedAsset.balanceOf(address(this));

        if (profitable) {
            bot.requestFlashLoanArbitrage(
                amount, address(adapter1), routeData1, address(adapter2), routeData2, 0, 0, 3600, block.timestamp + 1 hours
            );
            assertEq(
                borrowedAsset.balanceOf(address(this)) - ownerBalanceBefore,
                leg2Out - amountOwed,
                "enormous-profit WETH trade was blocked or paid out the wrong amount"
            );
        } else {
            vm.expectRevert(ProfitBelowGasCost.selector);
            bot.requestFlashLoanArbitrage(
                amount, address(adapter1), routeData1, address(adapter2), routeData2, 0, 0, 3600, block.timestamp + 1 hours
            );
        }
    }
}
