// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

// Requires forge-std: run `forge install foundry-rs/forge-std` first.
import "forge-std/Script.sol";

import "../contracts/DexArbitrageBotFlashLoan.sol";
import "../contracts/adapters/UniswapV3Adapter.sol";

/// @notice Deploys to Base SEPOLIA (chain ID 84532) -- a separate file from
/// Deploy.s.sol (mainnet) and DeploySepolia.s.sol (Ethereum Sepolia)
/// rather than a network branch in one file, so there's no chance of
/// accidentally mixing addresses across networks.
///
/// Only ONE adapter (Uniswap V3) is wired up here, matching the same
/// scope decision made in DeploySepolia.s.sol.
///
/// Every address below was confirmed live via `cast code` against Base
/// Sepolia directly -- not research alone. WETH is the sole exception,
/// trusted without a live check because it's an OP-stack genesis
/// predeploy at the same address on every OP-stack chain by protocol
/// design. The QuoterV2 address here replaced an earlier candidate
/// (0xc694a4cf10e2e4f77b49c35c5e6ea1b0fde6f6e8) that `cast code` found
/// had no contract at all, despite two independent sources agreeing on
/// it -- see notes/03 - Address Registry.md for the full log.
///
/// No USDC (or other ERC20) candidate has been verified on Base Sepolia
/// yet, so only WETH is approved below. Add a token approval once one
/// is confirmed the same way -- live `cast code`, not source agreement.
contract DeployBaseSepolia is Script {
    address constant BASE_SEPOLIA_WETH = 0x4200000000000000000000000000000000000006;
    address constant BASE_SEPOLIA_AAVE_ADDRESSES_PROVIDER = 0xE4C23309117Aa30342BFaae6c95c6478e0A4Ad00;
    address constant BASE_SEPOLIA_UNISWAP_V3_ROUTER02 = 0x94cC0AaC535CCDB3C01d6787D6413C739ae12bc4;
    address constant BASE_SEPOLIA_UNISWAP_V3_QUOTERV2 = 0xC5290058841028F1614F3A6F0F5816cAd0df5E27;

    function run() external {
        uint256 deployerKey = vm.envUint("PRIVATE_KEY");
        vm.startBroadcast(deployerKey);

        UniswapV3Adapter v3Adapter =
            new UniswapV3Adapter(BASE_SEPOLIA_UNISWAP_V3_ROUTER02, BASE_SEPOLIA_UNISWAP_V3_QUOTERV2);
        console.log("UniswapV3Adapter (Base Sepolia):", address(v3Adapter));

        DexArbitrageBotFlashLoan bot =
            new DexArbitrageBotFlashLoan(BASE_SEPOLIA_AAVE_ADDRESSES_PROVIDER, BASE_SEPOLIA_WETH);
        console.log("DexArbitrageBotFlashLoan (Base Sepolia):", address(bot));

        // Starts the approval cooldown -- NOT usable immediately. See
        // isAdapterApproved()/isTokenApproved() and approvalDelay
        // (24h default). Come back after the wait and confirm both
        // return true before submitting any real request.
        bot.approveAdapter(address(v3Adapter), true);
        bot.approveToken(BASE_SEPOLIA_WETH, true);

        // Nothing executes until this is set above 0. Left unset here on
        // purpose -- set it explicitly and deliberately once ready,
        // rather than as a byproduct of running this script.
        // bot.setMaxLoanAmount(0.01 ether);

        vm.stopBroadcast();
    }
}
