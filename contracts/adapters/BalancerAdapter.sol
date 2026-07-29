// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import "../interfaces/IDexAdapter.sol";
import "../libraries/RouteData.sol";
import "../libraries/SafeERC20.sol";
import "../libraries/CommonErrors.sol";

interface IBalancerVault {
    enum SwapKind {
        GIVEN_IN,
        GIVEN_OUT
    }

    struct SingleSwap {
        bytes32 poolId;
        SwapKind kind;
        address assetIn;
        address assetOut;
        uint256 amount;
        bytes userData;
    }

    struct FundManagement {
        address sender;
        bool fromInternalBalance;
        address payable recipient;
        bool toInternalBalance;
    }

    struct BatchSwapStep {
        bytes32 poolId;
        uint256 assetInIndex;
        uint256 assetOutIndex;
        uint256 amount;
        bytes userData;
    }

    function swap(
        SingleSwap memory singleSwap,
        FundManagement memory funds,
        uint256 limit,
        uint256 deadline
    ) external payable returns (uint256 amountCalculated);

    function queryBatchSwap(
        SwapKind kind,
        BatchSwapStep[] memory swaps,
        address[] memory assets,
        FundManagement memory funds
    ) external returns (int256[] memory assetDeltas);
}

error UnexpectedDeltaSign();

/// @notice Wraps a single Balancer V2 pool swap behind IDexAdapter.
///
/// SCOPE LIMIT: one pool, two tokens per leg -- same reasoning as the
/// Curve adapter. Balancer's batchSwap supports far more (multi-pool
/// batches, arbitrary asset graphs), but generalizing to that is real
/// added complexity outside this scope. tokens.length must be exactly 2.
///
/// routeData's `extra` field is abi.encode(bytes32 poolId).
///
/// CAUTION: quote() here uses the Vault's queryBatchSwap, which returns
/// signed asset deltas (positive = vault receives from the caller,
/// negative = vault pays out to the caller) -- this sign convention is a
/// known source of subtle bugs and is the part of this file most worth
/// testing against a live Vault before relying on it. swap()'s execution
/// path is Balancer's core, well-documented single-swap primitive and is
/// the higher-confidence half of this adapter.
contract BalancerAdapter is IDexAdapter {
    using SafeERC20 for address;
    using RouteData for bytes;

    IBalancerVault public immutable VAULT;

    constructor(address vault) {
        if (vault == address(0)) revert ZeroAddress();
        VAULT = IBalancerVault(vault);
    }

    function quote(bytes calldata routeData, uint256 amountIn) external override returns (uint256 amountOut) {
        (address[] memory tokens, bytes memory extra) = routeData.decode();
        if (tokens.length != 2) revert UnsupportedRoute();
        bytes32 poolId = abi.decode(extra, (bytes32));

        address[] memory assets = new address[](2);
        assets[0] = tokens[0];
        assets[1] = tokens[1];

        IBalancerVault.BatchSwapStep[] memory steps = new IBalancerVault.BatchSwapStep[](1);
        steps[0] = IBalancerVault.BatchSwapStep({
            poolId: poolId,
            assetInIndex: 0,
            assetOutIndex: 1,
            amount: amountIn,
            userData: ""
        });

        IBalancerVault.FundManagement memory funds = IBalancerVault.FundManagement({
            sender: address(this),
            fromInternalBalance: false,
            recipient: payable(address(this)),
            toInternalBalance: false
        });

        int256[] memory deltas = VAULT.queryBatchSwap(IBalancerVault.SwapKind.GIVEN_IN, steps, assets, funds);
        // assets[1]'s delta should be negative (the vault pays this out to
        // the caller). Explicit int->uint casts in Solidity reinterpret
        // bits rather than check sign, so if this assumption is ever wrong
        // (wrong Vault version, misread convention), casting a positive
        // delta here would silently wrap to a huge number instead of
        // failing -- fail loudly and immediately instead.
        if (deltas[1] > 0) revert UnexpectedDeltaSign();
        amountOut = uint256(-deltas[1]);
    }

    function swap(
        bytes calldata routeData,
        uint256 amountIn,
        uint256 minAmountOut,
        address recipient,
        uint256 deadline
    ) external override returns (uint256 amountOut) {
        (address[] memory tokens, bytes memory extra) = routeData.decode();
        if (tokens.length != 2) revert UnsupportedRoute();
        bytes32 poolId = abi.decode(extra, (bytes32));

        address tokenIn = tokens[0];
        tokenIn.safeTransferFrom(msg.sender, address(this), amountIn);
        tokenIn.safeApprove(address(VAULT), amountIn);

        IBalancerVault.SingleSwap memory singleSwap = IBalancerVault.SingleSwap({
            poolId: poolId,
            kind: IBalancerVault.SwapKind.GIVEN_IN,
            assetIn: tokenIn,
            assetOut: tokens[1],
            amount: amountIn,
            userData: ""
        });

        IBalancerVault.FundManagement memory funds = IBalancerVault.FundManagement({
            sender: address(this),
            fromInternalBalance: false,
            recipient: payable(recipient),
            toInternalBalance: false
        });

        amountOut = VAULT.swap(singleSwap, funds, minAmountOut, deadline);
    }
}
