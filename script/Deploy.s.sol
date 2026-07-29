// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

// Requires forge-std: run `forge install foundry-rs/forge-std` first.
import "forge-std/Script.sol";

import "../contracts/DexArbitrageBotFlashLoan.sol";
import "../contracts/adapters/UniswapV2Adapter.sol";
import "../contracts/adapters/UniswapV3Adapter.sol";
import "../contracts/adapters/CurveAdapter.sol";
import "../contracts/adapters/BalancerAdapter.sol";

/// @notice Deploys the full system and runs initial setup. Addresses below
/// are Ethereum mainnet values pulled from official docs/Etherscan at the
/// time this was written -- VERIFY EVERY ONE against the live source
/// before running this against real funds:
///   Aave:     https://docs.aave.com/developers/deployed-contracts/v3-mainnet
///   Uniswap:  https://docs.uniswap.org/contracts/v3/reference/deployments
///   Curve:    the specific pool's own page at https://curve.fi/dex/ethereum/pools
///   Balancer: https://docs.balancer.fi/reference/contracts/deployment-addresses
///
/// Curve is deliberately left out of DEFAULT_* below -- pick a specific
/// pool yourself and confirm it matches CurveAdapter's documented
/// int128-index interface before deploying an adapter for it.
contract Deploy is Script {
    address constant DEFAULT_WETH = 0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2;
    address constant DEFAULT_AAVE_ADDRESSES_PROVIDER = 0x2f39d218133AFaB8F2B819B1066c7E434Ad94E9e;
    address constant DEFAULT_UNISWAP_V2_ROUTER = 0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D;
    address constant DEFAULT_UNISWAP_V3_ROUTER02 = 0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45;
    // Corrected -- was a completely different, wrong address before, not
    // just a checksum typo. Verified against Etherscan, the official
    // Uniswap v3-periphery GitHub source, and three other chain explorers.
    address constant DEFAULT_UNISWAP_V3_QUOTERV2 = 0x61fFE014bA17989E743c5F6cB21bF9697530B21e;
    // Corrected -- was missing its trailing digit (39 hex chars instead
    // of 40) before. Verified against Etherscan, the official
    // balancer-deployments GitHub repo, and four other chain explorers.
    address constant DEFAULT_BALANCER_VAULT = 0xBA12222222228d8Ba445958a75a0704d566BF2C8;

    function run() external {
        uint256 deployerKey = vm.envUint("PRIVATE_KEY");
        vm.startBroadcast(deployerKey);

        // --- 1. Adapters -----------------------------------------------
        UniswapV2Adapter v2Adapter = new UniswapV2Adapter(DEFAULT_UNISWAP_V2_ROUTER);
        console.log("UniswapV2Adapter:", address(v2Adapter));

        UniswapV3Adapter v3Adapter =
            new UniswapV3Adapter(DEFAULT_UNISWAP_V3_ROUTER02, DEFAULT_UNISWAP_V3_QUOTERV2);
        console.log("UniswapV3Adapter:", address(v3Adapter));

        BalancerAdapter balAdapter = new BalancerAdapter(DEFAULT_BALANCER_VAULT);
        console.log("BalancerAdapter:", address(balAdapter));

        // Curve adapter is intentionally NOT deployed here -- pass your
        // chosen, verified pool address in manually, e.g.:
        // CurveAdapter curveAdapter = new CurveAdapter(YOUR_VERIFIED_CURVE_POOL);

        // --- 2. Executor -------------------------------------------------
        DexArbitrageBotFlashLoan bot =
            new DexArbitrageBotFlashLoan(DEFAULT_AAVE_ADDRESSES_PROVIDER, DEFAULT_WETH);
        console.log("DexArbitrageBotFlashLoan:", address(bot));

        // --- 3. Start the approval cooldown for each adapter --------------
        // These do NOT become usable immediately -- see isAdapterApproved()
        // and approvalDelay (24h default). Come back after the cooldown and
        // confirm isAdapterApproved(...) returns true before submitting any
        // real request.
        bot.approveAdapter(address(v2Adapter), true);
        bot.approveAdapter(address(v3Adapter), true);
        bot.approveAdapter(address(balAdapter), true);

        // --- 4. Approve tokens you intend to route through -----------------
        // Same cooldown applies. Add every token, not just endpoints --
        // any intermediate hop token needs approval too.
        bot.approveToken(DEFAULT_WETH, true);
        // bot.approveToken(USDC_ADDRESS, true);
        // bot.approveToken(DAI_ADDRESS, true);

        // --- 5. Circuit breaker -------------------------------------------
        // Nothing executes until this is set above 0. Start small.
        // bot.setMaxLoanAmount(1 ether);

        vm.stopBroadcast();
    }
}
