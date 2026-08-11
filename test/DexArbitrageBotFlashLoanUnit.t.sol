// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

// Requires forge-std: run `forge install foundry-rs/forge-std` first.
import "forge-std/Test.sol";

import "../contracts/DexArbitrageBotFlashLoan.sol";
import "../contracts/libraries/RouteData.sol";
import "../contracts/libraries/CommonErrors.sol";

/// @notice Pure unit tests -- no --fork-url needed. Every case here either
/// reverts before the flash-loan flow ever starts (access control, param
/// validation) or exercises state that doesn't depend on a real Aave pool
/// or DEX (the approval cooldown state machine, RouteData encoding). See
/// DeploySmokeTest.t.sol / BaseSepoliaSmokeTest.t.sol for the fork-based
/// tests that exercise the real integration instead.
contract MockPoolAddressesProvider {
    address public pool;

    constructor(address _pool) {
        pool = _pool;
    }

    function getPool() external view returns (address) {
        return pool;
    }
}

/// @dev Stand-in for "an adapter" or "a token" in tests that only need
/// `code.length > 0` to satisfy approveAdapter()/approveToken()'s
/// NotAContract guard -- none of these tests ever call into it.
contract DummyContract {}

contract DexArbitrageBotFlashLoanUnitTest is Test {
    using RouteData for bytes;

    DexArbitrageBotFlashLoan bot;
    MockPoolAddressesProvider addressesProvider;
    DummyContract mockPool;
    DummyContract adapter1;
    DummyContract adapter2;
    DummyContract wethToken;

    address WETH;
    address nonOwner = address(0xA11CE);

    function setUp() public {
        mockPool = new DummyContract();
        addressesProvider = new MockPoolAddressesProvider(address(mockPool));
        wethToken = new DummyContract();
        WETH = address(wethToken);
        bot = new DexArbitrageBotFlashLoan(address(addressesProvider), WETH);
        adapter1 = new DummyContract();
        adapter2 = new DummyContract();
    }

    function _validExecuteBefore() internal view returns (uint256) {
        return block.timestamp + 1 hours;
    }

    // =================================================================
    // (1) Owner-only access control
    // =================================================================

    function test_ApproveAdapter_RevertsForNonOwner() public {
        vm.prank(nonOwner);
        vm.expectRevert(NotOwner.selector);
        bot.approveAdapter(address(adapter1), true);
    }

    function test_ApproveToken_RevertsForNonOwner() public {
        vm.prank(nonOwner);
        vm.expectRevert(NotOwner.selector);
        bot.approveToken(WETH, true);
    }

    function test_SetMaxLoanAmount_RevertsForNonOwner() public {
        vm.prank(nonOwner);
        vm.expectRevert(NotOwner.selector);
        bot.setMaxLoanAmount(1 ether);
    }

    function test_TransferOwnership_RevertsForNonOwner() public {
        vm.prank(nonOwner);
        vm.expectRevert(NotOwner.selector);
        bot.transferOwnership(nonOwner);
    }

    // =================================================================
    // (2) Two-step ownership transfer
    // =================================================================

    function test_TransferOwnership_HasNoEffectUntilAccepted() public {
        address originalOwner = bot.owner();
        bot.transferOwnership(nonOwner);
        assertEq(bot.owner(), originalOwner, "owner should not change until accepted");
        assertEq(bot.pendingOwner(), nonOwner);
    }

    function test_AcceptOwnership_TransfersOwnership() public {
        bot.transferOwnership(nonOwner);
        vm.prank(nonOwner);
        bot.acceptOwnership();
        assertEq(bot.owner(), nonOwner);
        assertEq(bot.pendingOwner(), address(0), "pendingOwner should clear after acceptance");
    }

    function test_AcceptOwnership_RevertsForNonPendingOwner() public {
        bot.transferOwnership(nonOwner);
        vm.prank(address(0xBAD));
        vm.expectRevert(NotPendingOwner.selector);
        bot.acceptOwnership();
    }

    function test_TransferOwnership_RevertsOnZeroAddress() public {
        vm.expectRevert(ZeroAddress.selector);
        bot.transferOwnership(address(0));
    }

    function test_PendingOwnerNeverAccepts_OriginalOwnerStaysInControl() public {
        address originalOwner = bot.owner();
        bot.transferOwnership(nonOwner);

        vm.warp(block.timestamp + 365 days);

        assertEq(bot.owner(), originalOwner, "ownership must not transfer itself without acceptOwnership()");
        // Original owner can still act normally.
        bot.setMaxLoanAmount(1 ether);
        assertEq(bot.maxLoanAmount(), 1 ether);
    }

    // =================================================================
    // (3) Approval cooldown state machine
    // =================================================================

    function test_Adapter_NotApprovedInitially() public view {
        assertFalse(bot.isAdapterApproved(address(adapter1)));
    }

    function test_Adapter_NotApprovedDuringCooldown() public {
        bot.approveAdapter(address(adapter1), true);
        assertFalse(bot.isAdapterApproved(address(adapter1)), "should not be usable immediately after approval");

        vm.warp(block.timestamp + 24 hours - 1);
        assertFalse(bot.isAdapterApproved(address(adapter1)), "should not be usable one second before cooldown ends");
    }

    function test_Adapter_ApprovedAfterCooldown() public {
        bot.approveAdapter(address(adapter1), true);
        vm.warp(block.timestamp + 24 hours);
        assertTrue(bot.isAdapterApproved(address(adapter1)));
    }

    function test_Adapter_RevocationIsImmediate() public {
        bot.approveAdapter(address(adapter1), true);
        vm.warp(block.timestamp + 24 hours);
        assertTrue(bot.isAdapterApproved(address(adapter1)));

        bot.approveAdapter(address(adapter1), false);
        assertFalse(bot.isAdapterApproved(address(adapter1)), "revocation must be immediate, no cooldown");
    }

    function test_ApproveAdapter_RevertsForNonContractAddress() public {
        vm.expectRevert(abi.encodeWithSelector(NotAContract.selector, nonOwner));
        bot.approveAdapter(nonOwner, true);
    }

    function test_Token_FullCooldownLifecycle() public {
        assertFalse(bot.isTokenApproved(WETH));

        bot.approveToken(WETH, true);
        assertFalse(bot.isTokenApproved(WETH), "should not be usable immediately after approval");

        vm.warp(block.timestamp + 24 hours);
        assertTrue(bot.isTokenApproved(WETH));

        bot.approveToken(WETH, false);
        assertFalse(bot.isTokenApproved(WETH), "revocation must be immediate");
    }

    // =================================================================
    // (4) RouteData encode/decode round trip
    // =================================================================

    function test_RouteData_RoundTrip_TwoTokens() public pure {
        address[] memory tokens = new address[](2);
        tokens[0] = address(0x1);
        tokens[1] = address(0x2);
        bytes memory extra = hex"1234";

        bytes memory encoded = RouteData.encode(tokens, extra);
        (address[] memory decodedTokens, bytes memory decodedExtra) = RouteData.decode(encoded);

        assertEq(decodedTokens.length, 2);
        assertEq(decodedTokens[0], tokens[0]);
        assertEq(decodedTokens[1], tokens[1]);
        assertEq(decodedExtra, extra);
    }

    function test_RouteData_RoundTrip_ThreeTokens() public pure {
        address[] memory tokens = new address[](3);
        tokens[0] = address(0x1);
        tokens[1] = address(0x2);
        tokens[2] = address(0x3);
        bytes memory extra = "";

        bytes memory encoded = RouteData.encode(tokens, extra);
        (address[] memory decodedTokens, bytes memory decodedExtra) = RouteData.decode(encoded);

        assertEq(decodedTokens.length, 3);
        for (uint256 i = 0; i < 3; i++) {
            assertEq(decodedTokens[i], tokens[i]);
        }
        assertEq(decodedExtra.length, 0);
    }

    function test_RouteData_RoundTrip_SingleToken() public pure {
        address[] memory tokens = new address[](1);
        tokens[0] = address(0xABC);
        bytes memory extra = hex"deadbeef";

        bytes memory encoded = RouteData.encode(tokens, extra);
        (address[] memory decodedTokens, bytes memory decodedExtra) = RouteData.decode(encoded);

        assertEq(decodedTokens.length, 1);
        assertEq(decodedTokens[0], tokens[0]);
        assertEq(decodedExtra, extra);
    }

    function test_RouteData_RoundTrip_EmptyTokenArray() public pure {
        address[] memory tokens = new address[](0);
        bytes memory extra = "";

        bytes memory encoded = RouteData.encode(tokens, extra);
        (address[] memory decodedTokens, bytes memory decodedExtra) = RouteData.decode(encoded);

        assertEq(decodedTokens.length, 0);
        assertEq(decodedExtra.length, 0);
    }

    // =================================================================
    // (5) requestFlashLoanArbitrage early revert conditions
    // =================================================================

    function test_Request_RevertsOnExpiredDeadline() public {
        vm.expectRevert(RequestExpired.selector);
        bot.requestFlashLoanArbitrage(
            1 ether, address(adapter1), "", address(adapter2), "", 0, 300, 300, block.timestamp - 1
        );
    }

    function test_Request_RevertsOnZeroAmount() public {
        vm.expectRevert(ZeroAmount.selector);
        bot.requestFlashLoanArbitrage(
            0, address(adapter1), "", address(adapter2), "", 0, 300, 300, _validExecuteBefore()
        );
    }

    function test_Request_RevertsWhenAmountExceedsCap() public {
        // maxLoanAmount defaults to 0 -- any nonzero amount exceeds it.
        vm.expectRevert(AmountExceedsCap.selector);
        bot.requestFlashLoanArbitrage(
            1 ether, address(adapter1), "", address(adapter2), "", 0, 300, 300, _validExecuteBefore()
        );
    }

    function test_Request_RevertsWhenSlippageTooHigh() public {
        bot.setMaxLoanAmount(10 ether);
        vm.expectRevert(SlippageTooHigh.selector);
        bot.requestFlashLoanArbitrage(
            1 ether, address(adapter1), "", address(adapter2), "", 0, 1001, 300, _validExecuteBefore()
        );
    }

    function test_Request_RevertsWhenDeadlineSecondsIsZero() public {
        bot.setMaxLoanAmount(10 ether);
        vm.expectRevert(InvalidDeadline.selector);
        bot.requestFlashLoanArbitrage(
            1 ether, address(adapter1), "", address(adapter2), "", 0, 300, 0, _validExecuteBefore()
        );
    }

    function test_Request_RevertsWhenDeadlineSecondsTooLarge() public {
        bot.setMaxLoanAmount(10 ether);
        vm.expectRevert(InvalidDeadline.selector);
        bot.requestFlashLoanArbitrage(
            1 ether, address(adapter1), "", address(adapter2), "", 0, 300, 3601, _validExecuteBefore()
        );
    }

    function test_Request_RevertsForNonOwner() public {
        bot.setMaxLoanAmount(10 ether);
        vm.prank(nonOwner);
        vm.expectRevert(NotOwner.selector);
        bot.requestFlashLoanArbitrage(
            1 ether, address(adapter1), "", address(adapter2), "", 0, 300, 300, _validExecuteBefore()
        );
    }
}
