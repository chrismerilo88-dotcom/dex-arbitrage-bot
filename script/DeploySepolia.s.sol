// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

// Requires forge-std: run `forge install foundry-rs/forge-std` first.
import "forge-std/Script.sol";

import "../contracts/DexArbitrageBotFlashLoan.sol";
import "../contracts/adapters/UniswapV3Adapter.sol";

/// @notice Deploys to Ethereum SEPOLIA (chain ID 11155111) -- a separate
/// file from Deploy.s.sol (mainnet) rather than a network branch in one
/// file, so there's no chance of accidentally mixing mainnet and testnet
/// addresses.
///
/// Only ONE adapter (Uniswap V3) is wired up here, deliberately. This is
/// the DEX with the clearest, best-confirmed Sepolia deployment of the
/// four this project supports -- Curve and Balancer testnet coverage is
/// much less reliable, and V2 has no clean official Sepolia deployment.
/// Proving the deployment and configuration mechanics work end-to-end
/// with one adapter is the actual goal here, not deploying all four.
///
/// Every address below was independently verified against Etherscan
/// source code (not just address-matching) -- see the conversation this
/// script came from for exactly how one candidate SwapRouter02 address
/// was caught as wrong (spam-token-contaminated on Sepolia specifically,
/// despite being genuine on other networks) before being replaced with
/// this verified one.
///
/// IMPORTANT CAVEAT: contract addresses being correct doesn't mean real,
/// tradeable liquidity exists in a Sepolia WETH/USDC pool at any given
/// fee tier -- testnet DEX liquidity is often thin or absent. This script
/// proves deployment and setup mechanics on a live network; it does not
/// guarantee a profitable (or even executable) trade exists to try
/// afterward. Check with quoteRoute() before attempting a real request.
contract DeploySepolia is Script {
    address constant SEPOLIA_WETH = 0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14;
    address constant SEPOLIA_AAVE_ADDRESSES_PROVIDER = 0x2f39d218133AFaB8F2B819B1066c7E434Ad94E9e;
    address constant SEPOLIA_UNISWAP_V3_ROUTER02 = 0x3bFA4769FB09eefC5a80d6E87c3B9C650f7Ae48E;
    address constant SEPOLIA_UNISWAP_V3_QUOTERV2 = 0x61fFE014bA17989E743c5F6cB21bF9697530B21e;

    // Lower confidence than the four above -- only one source seen for
    // this one. Verify it independently before relying on it; if it
    // turns out wrong, only the token allowlist step below is affected,
    // nothing else in this script.
    address constant SEPOLIA_USDC_CANDIDATE = 0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238;

    function run() external {
        uint256 deployerKey = vm.envUint("PRIVATE_KEY");
        vm.startBroadcast(deployerKey);

        UniswapV3Adapter v3Adapter =
            new UniswapV3Adapter(SEPOLIA_UNISWAP_V3_ROUTER02, SEPOLIA_UNISWAP_V3_QUOTERV2);
        console.log("UniswapV3Adapter (Sepolia):", address(v3Adapter));

        DexArbitrageBotFlashLoan bot =
            new DexArbitrageBotFlashLoan(SEPOLIA_AAVE_ADDRESSES_PROVIDER, SEPOLIA_WETH);
        console.log("DexArbitrageBotFlashLoan (Sepolia):", address(bot));

        // Starts the approval cooldown -- NOT usable immediately. See
        // isAdapterApproved()/isTokenApproved() and approvalDelay
        // (24h default). Come back after the wait and confirm both
        // return true before submitting any real request.
        bot.approveAdapter(address(v3Adapter), true);
        bot.approveToken(SEPOLIA_WETH, true);
        bot.approveToken(SEPOLIA_USDC_CANDIDATE, true);

        // Nothing executes until this is set above 0. Left unset here on
        // purpose -- set it explicitly and deliberately once ready,
        // rather than as a byproduct of running this script.
        // bot.setMaxLoanAmount(0.01 ether);

        vm.stopBroadcast();
    }
}
