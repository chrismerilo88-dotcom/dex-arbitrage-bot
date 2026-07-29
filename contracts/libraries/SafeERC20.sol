// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

error ApproveResetFailed();
error ApproveFailed();
error TransferFailed();
error TransferFromFailed();

library SafeERC20 {
    function safeApprove(address token, address spender, uint256 amount) internal {
        (bool successZero, bytes memory dataZero) = token.call(
            abi.encodeWithSignature("approve(address,uint256)", spender, 0)
        );
        if (!successZero || (dataZero.length != 0 && !abi.decode(dataZero, (bool)))) {
            revert ApproveResetFailed();
        }

        (bool success, bytes memory data) = token.call(
            abi.encodeWithSignature("approve(address,uint256)", spender, amount)
        );
        if (!success || (data.length != 0 && !abi.decode(data, (bool)))) {
            revert ApproveFailed();
        }
    }

    /// @dev Single approve(spender, MAX) call, no reset-to-zero first.
    /// Only safe to use when the current allowance is already 0.
    function safeApproveMax(address token, address spender) internal {
        (bool success, bytes memory data) = token.call(
            abi.encodeWithSignature("approve(address,uint256)", spender, type(uint256).max)
        );
        if (!success || (data.length != 0 && !abi.decode(data, (bool)))) {
            revert ApproveFailed();
        }
    }

    /// @dev Sets an allowance straight to 0. Safe without the reset dance
    /// since going *to* zero (rather than between two nonzero values) is
    /// fine even on tokens like USDT that reject nonzero-to-nonzero changes.
    function safeRevoke(address token, address spender) internal {
        (bool success, bytes memory data) = token.call(
            abi.encodeWithSignature("approve(address,uint256)", spender, 0)
        );
        if (!success || (data.length != 0 && !abi.decode(data, (bool)))) {
            revert ApproveFailed();
        }
    }

    function safeTransfer(address token, address to, uint256 amount) internal {
        (bool success, bytes memory data) = token.call(
            abi.encodeWithSignature("transfer(address,uint256)", to, amount)
        );
        if (!success || (data.length != 0 && !abi.decode(data, (bool)))) {
            revert TransferFailed();
        }
    }

    /// @dev Used by adapters to pull funds from the executor. Checks the
    /// return value explicitly rather than ignoring it -- some ERC20
    /// tokens return false on failure instead of reverting.
    function safeTransferFrom(address token, address from, address to, uint256 amount) internal {
        (bool success, bytes memory data) = token.call(
            abi.encodeWithSignature("transferFrom(address,address,uint256)", from, to, amount)
        );
        if (!success || (data.length != 0 && !abi.decode(data, (bool)))) {
            revert TransferFromFailed();
        }
    }
}
