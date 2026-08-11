// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import "./interfaces/IDexAdapter.sol";
import "./libraries/RouteData.sol";
import "./libraries/SafeERC20.sol";
import "./libraries/CommonErrors.sol";

/*
 * DexArbitrageBotFlashLoan (v13 - forge-lint fixes)
 * ------------------------------------------
 * v1 -> v9 changelogs are unchanged from the previous version and omitted
 * here for brevity -- see git history. Summary of the arc so far:
 * reentrancy/lock design, profit auto-sweep, router/token allowlists,
 * request-level deadlines, redundant on-chain quote elimination,
 * balance-delta accounting, per-request routes replacing stored routers,
 * unlimited-approval opt-in with a reset-bug fix, Aave pool zero check,
 * a borrow-size circuit breaker, an approval cooldown + contract-existence
 * check, and router-revocation cleanup (auto-clearing unlimited-approval
 * mode on revoke, batch revocation).
 *
 * v10:
 *
 * 20. UNISWAP-V2-ONLY REPLACED WITH ADAPTER ARCHITECTURE: router1/path1/
 *     router2/path2 hardcoded a single V2-style swap interface
 *     (getAmountsOut/swapExactTokensForTokens), so Uniswap V3, Curve, and
 *     Balancer routes were structurally impossible, not just unsupported.
 *     Replaced with adapter1/routeData1/adapter2/routeData2: each adapter
 *     is a separately-deployed contract implementing the shared
 *     IDexAdapter interface (quote/swap), one per underlying router/pool/
 *     vault. The executor no longer knows or cares which protocol a given
 *     adapter wraps -- it decodes routeData's shared `tokens` prefix
 *     (see RouteData.sol) for allowlist checks and the round-trip
 *     invariant, and leaves the protocol-specific `extra` bytes entirely
 *     to the adapter. UniswapV2Adapter, UniswapV3Adapter, CurveAdapter,
 *     and BalancerAdapter ship alongside this file. approveRouter/
 *     approvedRouters/isRouterApproved are renamed to approveAdapter/
 *     adapterApprovedAt/isAdapterApproved accordingly -- the executor
 *     approves and calls adapters, never the underlying protocols
 *     directly. quoteRoute() is no longer `view`: IDexAdapter.quote()
 *     isn't view either, since Uniswap V3's on-chain quoter needs write
 *     access internally to simulate a swap. Call it via eth_call off-chain
 *     for a free read, same as you'd call any V3 quoter directly.
 *
 * 21. NO GAS-COST BACKSTOP: minProfit is supplied off-chain and is exactly
 *     where expectedProfit - Aave fee - DEX fees - gas - MEV bribe
 *     belongs (an ERC20 profit and an ETH gas cost aren't natively
 *     comparable on-chain without a price oracle for arbitrary borrowed
 *     tokens, so this can't be done generically here). But if gas price
 *     spikes between when minProfit was set and when the transaction
 *     lands, minProfit alone won't catch it. Added a backstop for the one
 *     case where it's clean to check on-chain without an oracle: when the
 *     borrowed asset is WETH, gas cost in wei and profit in wei are
 *     directly comparable. executeOperation() measures actual gas
 *     consumed via gasleft() and requires profit to clear it, in addition
 *     to minProfit. The constructor now takes a WETH address
 *     (network-specific) alongside addressesProvider.
 *
 * New in v11 (found during a follow-up manual review after v10 -- no
 * Foundry or Slither available in the environment that produced this, so
 * this was a targeted re-read against known vulnerability classes, not a
 * tool-driven audit; both items below are real fixes, not hypotheticals):
 *
 * 22. GAS BACKSTOP MEASURED LESS THAN IT CLAIMED TO: item 21's check ran
 *     *before* the repayment approval and profit sweep, so its own gas
 *     measurement silently excluded them -- the backstop was less
 *     complete than its own comment implied. Moved the check to after
 *     both. A revert unwinds everything above it regardless of where in
 *     the function it happens, so there's no cost to checking later, and
 *     the measurement now covers all of executeOperation's own gas
 *     (though still not the outer request transaction's base cost,
 *     calldata cost, or Aave's own bookkeeping before/after this callback
 *     -- that part of item 21's caveat still stands).
 *
 * 23. SILENT WRONG-SIGN FAILURE IN BalancerAdapter: its quote() cast a
 *     signed delta to uint256 via `uint256(-deltas[1])`, assuming that
 *     delta is always negative. Explicit int->uint casts in Solidity
 *     reinterpret bits rather than check sign -- if that assumption were
 *     ever wrong (wrong Vault version, misread convention), the cast
 *     wouldn't revert, it would silently produce a huge wrong number.
 *     Traced where that number flows: it only ever feeds a slippage-bound
 *     calculation elsewhere, which overflows (and cleanly reverts, via
 *     Solidity 0.8's checked arithmetic) when fed a number that large --
 *     so the practical failure mode was already "revert," not fund loss.
 *     Still added an explicit revert on a positive delta rather than
 *     relying on that incidental downstream overflow to catch it.
 *
 * New in v12 (found only once a real user actually ran `forge build`
 * against this project for the first time -- both issues below existed
 * from v10 onward but were invisible to every check run before this):
 *
 * 24. DUPLICATE FILE-LEVEL DECLARATIONS ACROSS ADAPTERS: UniswapV2Adapter,
 *     UniswapV3Adapter, CurveAdapter, and BalancerAdapter each
 *     independently declared their own local `error ZeroAddress()` and
 *     `interface IERC20Min`, and Curve/Balancer both also declared their
 *     own local `error UnsupportedRoute()`. Harmless on their own -- but
 *     the moment any single file imports more than one of them together
 *     (exactly what script/Deploy.s.sol and test/DeploySmokeTest.t.sol
 *     both do), Solidity finds multiple conflicting definitions of the
 *     same name and refuses to compile. Fixed by consolidating the shared
 *     declarations into contracts/interfaces/IERC20Min.sol and
 *     contracts/libraries/CommonErrors.sol, imported everywhere instead
 *     of redeclared per-file -- the same pattern SafeERC20.sol already
 *     used correctly from the start.
 *
 * 25. TWO WRONG ADDRESSES IN Deploy.s.sol: the Balancer Vault constant was
 *     missing its trailing hex digit (39 characters instead of 40) and
 *     the Uniswap V3 QuoterV2 constant was an entirely different, wrong
 *     address, not just a checksum-case typo. Both were only surfaced by
 *     actually compiling the deploy script (solc rejects malformed or
 *     wrongly-checksummed address literals) and were fixed after
 *     independently re-verifying the corrected values against Etherscan,
 *     the official Uniswap and Balancer GitHub source repositories, and
 *     multiple other chain explorers -- not by trusting solc's checksum
 *     auto-correction at face value, since that only validates casing,
 *     never whether the underlying digits are the right contract at all.
 *
 * New in v13 (surfaced by forge's built-in linter and a real "stack too
 * deep" compiler limit, both only visible once the project was actually
 * built with real Foundry against real, adapter-heavy functions):
 *
 * 26. STACK TOO DEEP IN executeOperation(): the function has enough local
 *     variables (gas tracking, decoded route data, profit accounting)
 *     that Solidity's default code generator ran out of stack slots to
 *     track them all. Fixed via foundry.toml, not a code change: via_ir
 *     enables Solidity's newer IR-based pipeline, which doesn't have this
 *     limitation, at the cost of slower compiles.
 *
 * 27. UNCHECKED transferFrom() RETURN VALUES IN EVERY ADAPTER: each
 *     adapter's swap() pulled funds via a raw transferFrom() call without
 *     checking its boolean return value -- some ERC20 tokens return false
 *     on failure instead of reverting, so a failed pull could in
 *     principle go unnoticed (in practice the swap likely still fails
 *     downstream when the adapter tries to move tokens it doesn't have,
 *     but there's no reason to rely on that). Fixed by adding
 *     safeTransferFrom() to SafeERC20.sol, matching the existing
 *     safeTransfer()/safeApprove() pattern, and switching all four
 *     adapters to it -- which also let the now-unnecessary IERC20Min
 *     import be dropped from each of them.
 *
 * NOT changed: forge-lint's three block-timestamp warnings (the two
 * approval-cooldown checks and the executeBefore deadline check). A
 * validator's ability to influence block.timestamp is on the order of
 * seconds; two of these compare against a 24-hour window and the third
 * is a staleness guard, not a security-critical cutoff. The warning is a
 * generic heuristic that doesn't translate into real risk at these
 * timescales, and switching to block-number-based logic would trade a
 * clear, human-readable window for a harder-to-reason-about one to guard
 * against a threat that doesn't apply here.
 */

interface IPoolAddressesProvider {
    function getPool() external view returns (address);
}

interface IPool {
    function flashLoanSimple(
        address receiverAddress,
        address asset,
        uint256 amount,
        bytes calldata params,
        uint16 referralCode
    ) external;

    function FLASHLOAN_PREMIUM_TOTAL() external view returns (uint128);
}

interface IFlashLoanSimpleReceiver {
    function executeOperation(
        address asset,
        uint256 amount,
        uint256 premium,
        address initiator,
        bytes calldata params
    ) external returns (bool);
}

interface IERC20 {
    function balanceOf(address account) external view returns (uint256);
    function allowance(address tokenOwner, address spender) external view returns (uint256);
}

// ---------------------------------------------------------------------
// Custom errors (cheaper than require(x, "string") on both deployment
// and revert).
// ---------------------------------------------------------------------
error NotOwner();
error ReentrancyBlocked();
error ContractPaused();
error RequestExpired();
error ZeroAmount();
error AmountExceedsCap();
error SlippageTooHigh();
error InvalidDeadline();
error TokenNotApproved(address token);
error AdapterNotApproved();
error NotAContract(address addr);
error InvalidApprovalDelay();
error InvalidRoute();
error NoViableRoute();
error CallerNotPool();
error UntrustedInitiator();
error NoActiveFlashLoan();
error InsufficientReturn();
error ProfitBelowMinimum();
error ProfitBelowGasCost();
error ETHWithdrawFailed();
error NotPendingOwner();
error NotOperator();

contract DexArbitrageBotFlashLoan is IFlashLoanSimpleReceiver {
    using SafeERC20 for address;
    using RouteData for bytes;

    address public owner;
    address public pendingOwner;
    IPool public immutable POOL;
    address public immutable WETH;

    /// @notice A separate, lower-privilege role that can submit requests
    /// (requestFlashLoanArbitrage) without holding any admin capability --
    /// approving adapters/tokens, withdrawing funds, changing owner, etc.
    /// stay onlyOwner. Lets the always-on off-chain bot hold a hot key
    /// that can only ever trigger trades, even after owner is migrated to
    /// a multisig/cold setup that can't sign every request in real time.
    /// Unset (address(0)) by default; owner can still call
    /// requestFlashLoanArbitrage directly regardless of whether an
    /// operator is set. See setOperator() below.
    address public operator;

    /// @notice Matches the version this file's header changelog is on --
    /// see CHANGELOG.md for the full history. Bump this alongside any
    /// future header changelog entry so it's checkable on-chain, not just
    /// in source comments.
    string public constant VERSION = "v13";

    bool public paused;
    bool public autoSweepProfit = true;

    /// @notice Circuit breaker on borrow size. Starts at 0, meaning no
    /// request can succeed at all until the owner explicitly calls
    /// setMaxLoanAmount() -- a fresh deployment is locked down by default,
    /// not silently uncapped.
    uint256 public maxLoanAmount;

    /// @notice Adapters must be approved, then wait out approvalDelay,
    /// before they can be passed as adapter1/adapter2 in a request. Value
    /// is the timestamp the approval was granted; 0 means never approved
    /// or since revoked. Use isAdapterApproved() to check usability.
    mapping(address => uint256) public adapterApprovedAt;

    /// @notice Same cooldown mechanics as adapterApprovedAt, but for every
    /// token anywhere in either leg's route -- not just the borrowed
    /// asset and the midpoint. Use isTokenApproved() to check usability.
    mapping(address => uint256) public tokenApprovedAt;

    /// @notice Per-adapter opt-in for unlimited approval instead of the
    /// default exact-amount-per-trade pattern. Off by default for every
    /// adapter.
    mapping(address => bool) public useUnlimitedApproval;

    /// @notice Cooldown a newly-approved adapter or token must wait out
    /// before it's usable. Applied dynamically against the stored
    /// approval timestamp, so changing this also reshapes the remaining
    /// wait for anything already pending. Defaults to 24 hours.
    uint256 public approvalDelay = 24 hours;

    // Single lock for the whole external entry (request -> callback ->
    // repayment). Distinct from _flashLoanActive, which exists so the
    // Aave-triggered nested call to executeOperation() doesn't try to
    // reacquire this same lock and deadlock against itself.
    //
    // _locked is uint8 (only ever 1 or 2, never 0) rather than uint256 so
    // it packs into the same storage slot as _flashLoanActive below --
    // the two are always written in the same transaction, so packing
    // them saves a cold SLOAD/SSTORE on every flash loan request.
    uint8 private _locked = 1;
    bool private _flashLoanActive;

    event FlashArbitrageExecuted(
        address indexed asset,
        uint256 amountBorrowed,
        uint256 premium,
        uint256 profit,
        address adapter1,
        address adapter2,
        bool profitSwept
    );
    event AdapterApprovalSet(address indexed adapter, bool approved, uint256 activatesAt);
    event TokenApprovalSet(address indexed token, bool approved, uint256 activatesAt);
    event ApprovalDelaySet(uint256 newDelay);
    event Paused(bool isPaused);
    event AutoSweepProfitSet(bool enabled);
    event Withdrawn(address indexed token, address indexed to, uint256 amount);
    event OwnershipTransferStarted(address indexed previousOwner, address indexed newOwner);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
    event UnlimitedApprovalSet(address indexed adapter, bool enabled);
    event ApprovalRevoked(address indexed token, address indexed adapter);
    event PoolSet(address pool);
    event MaxLoanAmountSet(uint256 newCap);
    event OperatorSet(address indexed operator);

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    /// @notice Owner always passes this too -- operator is an additional
    /// allowed caller for requestFlashLoanArbitrage, not a replacement.
    modifier onlyOperator() {
        if (msg.sender != operator && msg.sender != owner) revert NotOperator();
        _;
    }

    modifier nonReentrant() {
        if (_locked != 1) revert ReentrancyBlocked();
        _locked = 2;
        _;
        _locked = 1;
    }

    modifier whenNotPaused() {
        if (paused) revert ContractPaused();
        _;
    }

    /// @notice No adapters are approved at deploy time -- call
    /// approveAdapter() and approveToken() (and wait out approvalDelay),
    /// plus setMaxLoanAmount(), before the first request.
    constructor(address addressesProvider, address weth) {
        if (addressesProvider == address(0) || weth == address(0)) revert ZeroAddress();

        owner = msg.sender;
        WETH = weth;

        address pool = IPoolAddressesProvider(addressesProvider).getPool();
        if (pool == address(0)) revert ZeroAddress();
        POOL = IPool(pool);
        emit PoolSet(pool);
    }

    // ---------------------------------------------------------------
    // Read-only: approval status, accounting for the cooldown.
    // ---------------------------------------------------------------
    function isAdapterApproved(address adapter) public view returns (bool) {
        uint256 approvedAt = adapterApprovedAt[adapter];
        return approvedAt != 0 && block.timestamp >= approvedAt + approvalDelay;
    }

    function isTokenApproved(address token) public view returns (bool) {
        uint256 approvedAt = tokenApprovedAt[token];
        return approvedAt != 0 && block.timestamp >= approvedAt + approvalDelay;
    }

    // ---------------------------------------------------------------
    // Read-only: quote a specific route before spending any gas on it.
    // ---------------------------------------------------------------
    /// @notice Mirrors exactly what executeOperation() will do for this
    /// route, so a passing quote here should mean a passing execution,
    /// modulo price movement between the quote and the actual tx landing.
    /// @dev Not `view` -- see IDexAdapter.quote()'s doc comment for why.
    /// Call this via eth_call off-chain for a free read (nonReentrant
    /// doesn't affect that -- it's a real transaction guard, not a
    /// mutability restriction). Restricted to already-approved adapters:
    /// unrestricted, this let any caller force the executor to make
    /// arbitrary external calls (as msg.sender == executor) to an
    /// address of their choosing -- not fund-losing on its own today,
    /// but free ammunition against any future integration that trusts a
    /// call coming from this contract's address.
    function quoteRoute(
        uint256 amount,
        address adapter1,
        bytes calldata routeData1,
        address adapter2,
        bytes calldata routeData2
    ) external nonReentrant whenNotPaused returns (uint256 netProfit) {
        if (!isAdapterApproved(adapter1) || !isAdapterApproved(adapter2)) revert AdapterNotApproved();
        uint256 expectedMid = IDexAdapter(adapter1).quote(routeData1, amount);
        uint256 expectedFinal = IDexAdapter(adapter2).quote(routeData2, expectedMid);

        uint256 premiumBps = POOL.FLASHLOAN_PREMIUM_TOTAL();
        uint256 amountOwed = amount + (amount * premiumBps) / 10000;

        netProfit = expectedFinal > amountOwed ? expectedFinal - amountOwed : 0;
    }

    /// @dev routeData1's tokens must start with the token being borrowed
    /// and routeData2's tokens must end with it, with routeData1's last
    /// token matching routeData2's first -- i.e. the route must actually
    /// round-trip back to the borrowed asset. Every token in both routes
    /// must pass isTokenApproved(), not just the endpoints, since
    /// intermediate hops move real value too.
    function _requireValidRoute(bytes calldata routeData1, bytes calldata routeData2)
        internal
        view
        returns (address asset)
    {
        (address[] memory tokens1, ) = routeData1.decode();
        (address[] memory tokens2, ) = routeData2.decode();

        if (tokens1.length < 2 || tokens2.length < 2) revert InvalidRoute();
        if (tokens1[tokens1.length - 1] != tokens2[0]) revert InvalidRoute();
        if (tokens2[tokens2.length - 1] != tokens1[0]) revert InvalidRoute();
        // Degenerate leg-1 shape (e.g. [WETH, X, WETH]) would make
        // _executeRoute's midToken == tokenIn, so the balance-delta
        // subtraction there underflows into an opaque panic instead of a
        // named revert -- reject it here with a clear error instead.
        if (tokens1[0] == tokens1[tokens1.length - 1]) revert InvalidRoute();

        for (uint256 i = 0; i < tokens1.length; i++) {
            if (!isTokenApproved(tokens1[i])) revert TokenNotApproved(tokens1[i]);
        }
        for (uint256 i = 0; i < tokens2.length; i++) {
            if (!isTokenApproved(tokens2[i])) revert TokenNotApproved(tokens2[i]);
        }

        asset = tokens1[0];
    }

    // ---------------------------------------------------------------
    // Step 1: request the flash loan for a specific, caller-supplied route.
    // ---------------------------------------------------------------
    /// @param amount Amount of the borrowed asset (routeData1's first token) to borrow and trade.
    /// @param adapter1 Adapter for leg 1. Must be approved (post-cooldown).
    /// @param routeData1 Leg 1 route, see RouteData.sol. Its first token is the borrowed asset.
    /// @param adapter2 Adapter for leg 2. Must be approved (post-cooldown).
    /// @param routeData2 Leg 2 route. Must start where routeData1 ends and end back at the borrowed asset.
    /// @param minProfit Minimum net profit (after Aave's premium) required, in borrowed-asset units.
    /// @param slippageBps Max slippage tolerance per leg, in basis points (capped at 1000 = 10%).
    /// NOT a real MEV/sandwich guard: the bound it produces is computed from a
    /// quote taken in this same transaction (see _executeRoute), so it reads
    /// post-frontrun state just like the swap it's meant to protect --
    /// against a sandwich, both numbers move together and the bound can
    /// essentially never trip. Its actual job is bounding ordinary same-block
    /// quote-to-swap drift (nothing else can touch these pools mid-transaction,
    /// see _executeRoute's doc comment), not adversarial price manipulation.
    /// minProfit is what actually protects principal against a bad fill,
    /// including a sandwiched one -- it's checked against realized balances
    /// after both legs, independent of what slippageBps allowed through.
    /// @param deadlineSeconds Router-call deadline window, applied from block.timestamp at execution.
    /// @param executeBefore Unix timestamp; the request reverts immediately if the transaction
    /// lands after this, instead of executing later against stale conditions you never approved.
    function requestFlashLoanArbitrage(
        uint256 amount,
        address adapter1,
        bytes calldata routeData1,
        address adapter2,
        bytes calldata routeData2,
        uint256 minProfit,
        uint256 slippageBps,
        uint256 deadlineSeconds,
        uint256 executeBefore
    ) external onlyOperator nonReentrant whenNotPaused {
        if (block.timestamp > executeBefore) revert RequestExpired();
        if (amount == 0) revert ZeroAmount();
        if (amount > maxLoanAmount) revert AmountExceedsCap();
        if (slippageBps > 1000) revert SlippageTooHigh();
        if (deadlineSeconds == 0 || deadlineSeconds > 3600) revert InvalidDeadline();
        if (!isAdapterApproved(adapter1)) revert AdapterNotApproved();
        if (!isAdapterApproved(adapter2)) revert AdapterNotApproved();
        address asset = _requireValidRoute(routeData1, routeData2);

        bytes memory params =
            abi.encode(adapter1, routeData1, adapter2, routeData2, minProfit, slippageBps, deadlineSeconds);

        _flashLoanActive = true;
        POOL.flashLoanSimple(address(this), asset, amount, params, 0);
        _flashLoanActive = false;
    }

    // ---------------------------------------------------------------
    // Step 2-5: Aave's callback. Receive funds, execute the route, repay,
    // sweep profit.
    // ---------------------------------------------------------------
    function executeOperation(
        address asset,
        uint256 amount,
        uint256 premium,
        address initiator,
        bytes calldata params
    ) external override returns (bool) {
        uint256 gasStart = gasleft();

        // Access control, not a reentrancy lock: only the real Aave Pool
        // can call this, only mid-flow for a loan this contract itself
        // requested. This intentionally does NOT use the nonReentrant
        // modifier -- that lock is already held by the outer
        // requestFlashLoanArbitrage() call for the whole duration of this
        // nested call, so re-acquiring it here would always fail.
        if (msg.sender != address(POOL)) revert CallerNotPool();
        if (initiator != address(this)) revert UntrustedInitiator();
        if (!_flashLoanActive) revert NoActiveFlashLoan();

        (
            address adapter1,
            bytes memory routeData1,
            address adapter2,
            bytes memory routeData2,
            uint256 minProfit,
            uint256 slippageBps,
            uint256 deadlineSeconds
        ) = abi.decode(params, (address, bytes, address, bytes, uint256, uint256, uint256));

        uint256 finalAmount =
            _executeRoute(amount, adapter1, routeData1, adapter2, routeData2, slippageBps, deadlineSeconds);

        uint256 amountOwed = amount + premium;
        if (finalAmount <= amountOwed) revert InsufficientReturn();
        uint256 profit = finalAmount - amountOwed;
        if (profit < minProfit) revert ProfitBelowMinimum();

        // WETH gas backstop -- see item 21 in the header for why this is
        // WETH-specific and approximate rather than exact. Checked after
        // the repayment approval and profit sweep below (not before) so
        // the measurement covers their gas cost too, not just the route
        // execution -- if this reverts, everything above still unwinds
        // together with it, so there's no cost to checking later.
        // Repay principal + premium.
        _ensureApproval(asset, address(POOL), amountOwed);

        // Sweep profit straight to the owner instead of leaving it sitting
        // in the contract. Safe to do here: profit is the leftover after
        // the repayment amount is already accounted for and approved: this
        // transfer only ever moves the surplus, never the amount Aave needs.
        bool swept = false;
        if (profit > 0 && autoSweepProfit) {
            asset.safeTransfer(owner, profit);
            swept = true;
        }

        if (asset == WETH) {
            uint256 gasCostWei = (gasStart - gasleft()) * tx.gasprice;
            if (profit < gasCostWei) revert ProfitBelowGasCost();
        }

        emit FlashArbitrageExecuted(asset, amount, premium, profit, adapter1, adapter2, swept);
        return true;
    }

    /// @dev Quotes both legs upfront (one pass, before any swap happens),
    /// then executes them and measures actual amounts via balance deltas
    /// rather than trusting each adapter's return value -- correct even
    /// for fee-on-transfer or otherwise non-standard tokens, and doesn't
    /// depend on a given adapter's return value being honest. Reusing the
    /// upfront quotes for slippage bounds instead of re-querying mid-flow
    /// is safe because nothing can touch pool reserves between the quote
    /// and the swap: both happen in the same atomic transaction, under
    /// the outer lock.
    function _executeRoute(
        uint256 amountIn,
        address adapter1,
        bytes memory routeData1,
        address adapter2,
        bytes memory routeData2,
        uint256 slippageBps,
        uint256 deadlineSeconds
    ) internal returns (uint256 finalAmount) {
        (address[] memory tokens1, ) = routeData1.decode();
        address tokenIn = tokens1[0];
        address midToken = tokens1[tokens1.length - 1];
        uint256 deadline = block.timestamp + deadlineSeconds;

        uint256 expectedMid = IDexAdapter(adapter1).quote(routeData1, amountIn);
        uint256 expectedFinal = IDexAdapter(adapter2).quote(routeData2, expectedMid);
        if (expectedMid == 0 || expectedFinal == 0) revert NoViableRoute();

        uint256 minMid = (expectedMid * (10000 - slippageBps)) / 10000;
        uint256 balMidBefore = IERC20(midToken).balanceOf(address(this));

        _ensureApproval(tokenIn, adapter1, amountIn);
        IDexAdapter(adapter1).swap(routeData1, amountIn, minMid, address(this), deadline);

        uint256 midReceived = IERC20(midToken).balanceOf(address(this)) - balMidBefore;

        uint256 minFinal = (expectedFinal * (10000 - slippageBps)) / 10000;
        uint256 balInBefore = IERC20(tokenIn).balanceOf(address(this));

        _ensureApproval(midToken, adapter2, midReceived);
        IDexAdapter(adapter2).swap(routeData2, midReceived, minFinal, address(this), deadline);

        finalAmount = IERC20(tokenIn).balanceOf(address(this)) - balInBefore;
    }

    /// @dev Two approval strategies, chosen per spender (an adapter's
    /// address) via useUnlimitedApproval:
    ///  - default (false): exact-amount approve every time (reset-to-zero,
    ///    then approve amount). Nothing is ever left outstanding between
    ///    trades.
    ///  - opt-in (true): check the existing allowance first. If it's a
    ///    confirmed 0, approve MAX in a single call. If it's some smaller
    ///    nonzero value, still do the reset-then-approve dance, since some
    ///    tokens reject changing a nonzero allowance straight to another
    ///    nonzero value. Once allowance reaches MAX this branch is never
    ///    entered again for that adapter.
    function _ensureApproval(address token, address spender, uint256 amount) internal {
        if (useUnlimitedApproval[spender]) {
            uint256 currentAllowance = IERC20(token).allowance(address(this), spender);
            if (currentAllowance < amount) {
                if (currentAllowance == 0) {
                    token.safeApproveMax(spender);
                } else {
                    token.safeApprove(spender, type(uint256).max);
                }
            }
        } else {
            token.safeApprove(spender, amount);
        }
    }

    // ---------------------------------------------------------------
    // Admin
    // ---------------------------------------------------------------

    /// @notice Approve or revoke an adapter address for use as
    /// adapter1/adapter2 in a request. A new approval doesn't take effect
    /// for approvalDelay -- check isAdapterApproved() before relying on
    /// it. Revoking is immediate, and also clears useUnlimitedApproval
    /// for that adapter so a later re-approval always requires a fresh,
    /// explicit opt-in.
    function approveAdapter(address adapter, bool approved) external onlyOwner {
        if (adapter == address(0)) revert ZeroAddress();
        uint256 activatesAt;
        if (approved) {
            if (adapter.code.length == 0) revert NotAContract(adapter);
            if (adapterApprovedAt[adapter] == 0) {
                adapterApprovedAt[adapter] = block.timestamp;
            }
            activatesAt = adapterApprovedAt[adapter] + approvalDelay;
        } else {
            adapterApprovedAt[adapter] = 0;
            if (useUnlimitedApproval[adapter]) {
                useUnlimitedApproval[adapter] = false;
                emit UnlimitedApprovalSet(adapter, false);
            }
        }
        emit AdapterApprovalSet(adapter, approved, activatesAt);
    }

    /// @notice Approve or revoke a token for use anywhere in a route.
    /// A new approval doesn't take effect for approvalDelay -- check
    /// isTokenApproved() before relying on it. Revoking is immediate.
    function approveToken(address token, bool approved) external onlyOwner {
        if (token == address(0)) revert ZeroAddress();
        uint256 activatesAt;
        if (approved) {
            if (token.code.length == 0) revert NotAContract(token);
            if (tokenApprovedAt[token] == 0) {
                tokenApprovedAt[token] = block.timestamp;
            }
            activatesAt = tokenApprovedAt[token] + approvalDelay;
        } else {
            tokenApprovedAt[token] = 0;
        }
        emit TokenApprovalSet(token, approved, activatesAt);
    }

    /// @notice How long a newly-approved adapter or token must wait
    /// before it's usable. Applies immediately to anything already
    /// pending. Capped at 30 days to guard against an accidental
    /// permanent lockout.
    function setApprovalDelay(uint256 newDelay) external onlyOwner {
        if (newDelay > 30 days) revert InvalidApprovalDelay();
        approvalDelay = newDelay;
        emit ApprovalDelaySet(newDelay);
    }

    /// @notice Opt an adapter into unlimited-approval mode (or back out
    /// of it). Only ever settable for adapters that are fully approved
    /// (cooldown already elapsed). Defaults to false and stays false
    /// until called.
    function setUnlimitedApproval(address adapter, bool enabled) external onlyOwner {
        if (!isAdapterApproved(adapter)) revert AdapterNotApproved();
        useUnlimitedApproval[adapter] = enabled;
        emit UnlimitedApprovalSet(adapter, enabled);
    }

    /// @notice Zero out a specific token's allowance to a specific
    /// adapter. Does not depend on useUnlimitedApproval's current value
    /// -- use this to explicitly clear an allowance that was granted
    /// while unlimited approval was enabled, e.g. right after turning it
    /// off for an adapter you no longer trust, or as a precaution at any
    /// time.
    function revokeApproval(address token, address adapter) external onlyOwner {
        token.safeRevoke(adapter);
        emit ApprovalRevoked(token, adapter);
    }

    /// @notice Same as revokeApproval(), but for multiple tokens against
    /// one adapter in a single transaction -- useful for cleaning up
    /// every standing allowance a compromised adapter was given while
    /// unlimited approval was on for it. Solidity mappings aren't
    /// enumerable, so there's no way to discover that token list
    /// on-chain; supply it from your own records.
    function revokeApprovalBatch(address[] calldata tokens, address adapter) external onlyOwner {
        for (uint256 i = 0; i < tokens.length; i++) {
            tokens[i].safeRevoke(adapter);
            emit ApprovalRevoked(tokens[i], adapter);
        }
    }

    /// @notice Raise or lower the borrow-size circuit breaker. Set to 0
    /// to block all requests again (e.g. while investigating an issue,
    /// as an alternative to the blunter setPaused()).
    function setMaxLoanAmount(uint256 newCap) external onlyOwner {
        maxLoanAmount = newCap;
        emit MaxLoanAmountSet(newCap);
    }

    /// @notice Set (or clear, via address(0)) the operator allowed to call
    /// requestFlashLoanArbitrage without holding owner's admin privileges.
    /// Deliberately does not require the new operator to be a contract or
    /// pass any other check -- it's meant to be a plain hot-wallet EOA.
    function setOperator(address newOperator) external onlyOwner {
        operator = newOperator;
        emit OperatorSet(newOperator);
    }

    function setPaused(bool _paused) external onlyOwner {
        paused = _paused;
        emit Paused(_paused);
    }

    function setAutoSweepProfit(bool enabled) external onlyOwner {
        autoSweepProfit = enabled;
        emit AutoSweepProfitSet(enabled);
    }

    /// @notice Manual withdrawal -- still needed if autoSweepProfit is off,
    /// or to recover any token balance for any other reason.
    function withdrawToken(address token, uint256 amount) external onlyOwner nonReentrant {
        token.safeTransfer(owner, amount);
        emit Withdrawn(token, owner, amount);
    }

    function withdrawETH() external onlyOwner nonReentrant {
        uint256 bal = address(this).balance;
        (bool sent, ) = owner.call{value: bal}("");
        if (!sent) revert ETHWithdrawFailed();
        emit Withdrawn(address(0), owner, bal);
    }

    /// @notice Step 1 of 2: propose a new owner. Has no effect until that
    /// address calls acceptOwnership(). Prevents a typo'd or unreachable
    /// address from permanently locking the contract.
    function transferOwnership(address newOwner) external onlyOwner {
        if (newOwner == address(0)) revert ZeroAddress();
        pendingOwner = newOwner;
        emit OwnershipTransferStarted(owner, newOwner);
    }

    /// @notice Step 2 of 2: the proposed owner claims ownership.
    function acceptOwnership() external {
        if (msg.sender != pendingOwner) revert NotPendingOwner();
        emit OwnershipTransferred(owner, pendingOwner);
        owner = pendingOwner;
        pendingOwner = address(0);
    }

    receive() external payable {}
}
