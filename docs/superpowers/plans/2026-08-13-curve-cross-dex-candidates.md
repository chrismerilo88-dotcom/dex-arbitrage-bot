# Curve Cross-DEX Candidate Pairing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a Curve leg pair against a different generic (v2/v3) adapter instead of always round-tripping through the same Curve pool (which can never be profitable), and deploy this against Ethereum Mainnet's real, live-verified 3pool.

**Architecture:** A new pure function `buildCurveCrossCandidates()` in `off-chain-bot/lib.js` builds two candidates per generic adapter (Curve-out/generic-back, and reversed) given an already-resolved Curve pool pairing. `index.js`'s `resolveCurveCandidates()` is replaced by `resolveCurveCrossCandidates()`, which keeps the existing pool/coin discovery but calls the new builder instead of constructing a same-pool round trip. Ethereum Mainnet's `.env.mainnet` is reconfigured (`BORROWED_ASSET` WETH→USDC, `VIA_TOKENS` gains WETH, `ADAPTERS` gains a newly-deployed Curve adapter) and the scanner is restarted.

**Tech Stack:** Node.js (`node:test`), ethers v6, Foundry/`cast` for on-chain deployment, existing `off-chain-bot/` structure.

## Global Constraints

- 2-leg only — no triangular routes involving a Curve leg (`CurveAdapter.sol` requires exactly 2 tokens per leg).
- The same-pool round-trip candidate is dropped entirely, not kept alongside the new cross-adapter candidates.
- `prefilterCandidates()`/`rankCandidates()`/`tryRoute()` are not modified — already verified to handle an unpriced/unknown-protocol hop safely.
- Curve 3pool, verified live: `0xbEbc44782C7dB0a1A60Cb6fe97d0b483032FF1C7`. `coins(0)=DAI (0x6B175474E89094C44Da98b954EedeAC495271d0F)`, `coins(1)=USDC (0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48)`, `coins(2)=USDT (0xdAC17F958D2ee523a2206206994597C13D831ec7)`.
- Ethereum Mainnet executor: `0x03e22682AA1e319E55598B89A3366083b2d28051`. `maxLoanAmount` stays `0` throughout — DRY_RUN only, no execution changes.
- Arbitrum and BNB Chain scanners are unaffected (no curve-tagged adapters configured for them) and must keep working unmodified.

Spec: `docs/superpowers/specs/2026-08-13-curve-cross-dex-candidates-design.md`

---

### Task 1: `buildCurveCrossCandidates()` in `lib.js`

**Files:**
- Modify: `off-chain-bot/lib.js` (add the new function; existing functions unchanged)
- Test: `off-chain-bot/lib.test.js` (add a new `describe` block; existing tests unchanged)

**Interfaces:**
- Produces: `buildCurveCrossCandidates({ curveAdapterAddress, genericAdapters, borrowedAsset, otherToken, curveIOut, curveJOut, feeTiers, amount, minProfit, slippageBps }) -> Array<candidate>`, where each candidate has the same shape `buildTwoLegCandidates` already produces: `{ amount, adapter1, routeData1, adapter2, routeData2, minProfit, slippageBps, _hops: [{ protocol, tokenIn, tokenOut, fee }, ...] }`. `genericAdapters` is `Array<{ address, protocol }>` (same shape `parseAdapterList` already produces). `curveIOut`/`curveJOut` are the Curve pool's own coin indices for `borrowedAsset`/`otherToken` respectively (numbers, e.g. `0`/`1`).

- [ ] **Step 1: Write the failing tests**

Add this `describe` block to `off-chain-bot/lib.test.js`, right after the existing `describe('candidate building', ...)` block (after its closing `});` on line 177):

```javascript
describe('buildCurveCrossCandidates', () => {
  const curveConfig = {
    curveAdapterAddress: ADAPTER_A,
    genericAdapters: [{ address: ADAPTER_B, protocol: 'v3' }],
    borrowedAsset: USDC,
    otherToken: DAI,
    curveIOut: 1,
    curveJOut: 0,
    feeTiers: [500, 3000],
    amount: 100n,
    minProfit: 0n,
    slippageBps: 300,
  };

  test('produces two candidates per generic adapter per fee tier (both pairing directions)', () => {
    const candidates = lib.buildCurveCrossCandidates(curveConfig);
    // 1 generic adapter x 2 fee tiers x 2 directions = 4
    assert.equal(candidates.length, 4);
  });

  test('curve-out direction: adapter1 is curve, adapter2 is the generic adapter', () => {
    const candidates = lib.buildCurveCrossCandidates(curveConfig);
    const curveOut = candidates.filter((c) => c.adapter1 === ADAPTER_A);
    assert.equal(curveOut.length, 2); // one per fee tier
    for (const c of curveOut) {
      assert.equal(c.adapter2, ADAPTER_B);
    }
  });

  test('generic-out direction: adapter1 is the generic adapter, adapter2 is curve', () => {
    const candidates = lib.buildCurveCrossCandidates(curveConfig);
    const genericOut = candidates.filter((c) => c.adapter1 === ADAPTER_B);
    assert.equal(genericOut.length, 2);
    for (const c of genericOut) {
      assert.equal(c.adapter2, ADAPTER_A);
    }
  });

  test('curve leg route data decodes to borrowedAsset/otherToken with the correct coin indices', () => {
    const candidates = lib.buildCurveCrossCandidates(curveConfig);
    const curveOut = candidates.find((c) => c.adapter1 === ADAPTER_A);
    const [tokens, extra] = ethers.AbiCoder.defaultAbiCoder().decode(['address[]', 'bytes'], curveOut.routeData1);
    assert.deepEqual([...tokens], [USDC, DAI]);
    const [i, j] = ethers.AbiCoder.defaultAbiCoder().decode(['int128', 'int128'], extra);
    assert.equal(i, 1n);
    assert.equal(j, 0n);
  });

  test('the return leg of the curve-out direction is the curve leg reversed (otherToken -> borrowedAsset, indices swapped)', () => {
    const candidates = lib.buildCurveCrossCandidates(curveConfig);
    const curveOut = candidates.find((c) => c.adapter1 === ADAPTER_A);
    const [tokens, extra] = ethers.AbiCoder.defaultAbiCoder().decode(['address[]', 'bytes'], candidates.find((c) => c.adapter2 === ADAPTER_A).routeData2);
    assert.deepEqual([...tokens], [DAI, USDC]);
    const [i, j] = ethers.AbiCoder.defaultAbiCoder().decode(['int128', 'int128'], extra);
    assert.equal(i, 0n);
    assert.equal(j, 1n);
    void curveOut; // (referenced above only to locate the pair; assertion is on the found candidate)
  });

  test('collapses the fee-tier loop for a v2 generic adapter', () => {
    const candidates = lib.buildCurveCrossCandidates({
      ...curveConfig,
      genericAdapters: [{ address: ADAPTER_B, protocol: 'v2' }],
    });
    // 1 generic adapter x 1 (no fee loop) x 2 directions = 2
    assert.equal(candidates.length, 2);
  });

  test('multiple generic adapters each produce their own candidate pairs', () => {
    const candidates = lib.buildCurveCrossCandidates({
      ...curveConfig,
      genericAdapters: [
        { address: ADAPTER_B, protocol: 'v2' },
        { address: '0xcCcCcCcCcCcCcCcCcCcCcCcCcCcCcCcCcCcCcCcC', protocol: 'v2' },
      ],
    });
    // 2 generic adapters x 1 (v2, no fee loop) x 2 directions = 4
    assert.equal(candidates.length, 4);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd off-chain-bot && node --test lib.test.js`
Expected: FAIL — `lib.buildCurveCrossCandidates is not a function`

- [ ] **Step 3: Write the implementation**

Add this function to `off-chain-bot/lib.js`, right after `buildTriangularCandidates` (after its closing `}` — the function currently ends around line 207, immediately before `function hopKey(hop) {`):

```javascript
/**
 * Pairs a single Curve leg against every generic (v2/v3) adapter, in
 * both directions -- the combination `resolveCurveCandidates` never
 * produced (it only ever round-tripped through the same Curve pool,
 * which can never be profitable). Given an already-resolved pairing
 * (which token the pool trades against `borrowedAsset`, and that pool's
 * own coin indices for each), builds:
 *   - borrowed -> otherToken (Curve) -> borrowed (generic adapter)
 *   - borrowed -> otherToken (generic adapter) -> borrowed (Curve)
 * CurveAdapter.sol requires exactly 2 tokens per leg, so unlike
 * buildTriangularCandidates, there's no multi-hop-in-one-leg variant
 * here -- 2-leg only.
 */
function buildCurveCrossCandidates({
  curveAdapterAddress,
  genericAdapters,
  borrowedAsset,
  otherToken,
  curveIOut,
  curveJOut,
  feeTiers,
  amount,
  minProfit,
  slippageBps,
}) {
  const candidates = [];
  const curveOutRouteData = encodeCurveRouteData([borrowedAsset, otherToken], curveIOut, curveJOut);
  const curveBackRouteData = encodeCurveRouteData([otherToken, borrowedAsset], curveJOut, curveIOut);

  for (const generic of genericAdapters) {
    const fees = generic.protocol === 'v3' ? feeCombos(feeTiers, 1) : [[]];
    for (const [fee] of fees) {
      // Curve out, generic adapter back.
      candidates.push({
        amount,
        adapter1: curveAdapterAddress,
        routeData1: curveOutRouteData,
        adapter2: generic.address,
        routeData2: encodeForProtocol(generic.protocol, [otherToken, borrowedAsset], [fee]),
        minProfit,
        slippageBps,
        _hops: [
          { protocol: 'curve', tokenIn: borrowedAsset, tokenOut: otherToken, fee: undefined },
          { protocol: generic.protocol, tokenIn: otherToken, tokenOut: borrowedAsset, fee },
        ],
      });

      // Generic adapter out, Curve back.
      candidates.push({
        amount,
        adapter1: generic.address,
        routeData1: encodeForProtocol(generic.protocol, [borrowedAsset, otherToken], [fee]),
        adapter2: curveAdapterAddress,
        routeData2: curveBackRouteData,
        minProfit,
        slippageBps,
        _hops: [
          { protocol: generic.protocol, tokenIn: borrowedAsset, tokenOut: otherToken, fee },
          { protocol: 'curve', tokenIn: otherToken, tokenOut: borrowedAsset, fee: undefined },
        ],
      });
    }
  }

  return candidates;
}
```

Then add `buildCurveCrossCandidates` to the `module.exports` block at the bottom of `off-chain-bot/lib.js` (alongside the existing `buildTwoLegCandidates`, `buildTriangularCandidates`, etc.).

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd off-chain-bot && node --test lib.test.js`
Expected: PASS — all tests in the file, including the new `buildCurveCrossCandidates` block, green

- [ ] **Step 5: Commit**

```bash
cd /home/chrismerilo88/dex-arbitrage-bot
git add off-chain-bot/lib.js off-chain-bot/lib.test.js
git commit -m "feat: add buildCurveCrossCandidates for Curve-vs-generic-adapter pairing"
```

---

### Task 2: Wire `index.js` to use the new candidate builder

**Files:**
- Modify: `off-chain-bot/index.js:667-697` (`resolveCurveCandidates` → `resolveCurveCrossCandidates`), `off-chain-bot/index.js:858-874` (`buildCandidates`' call site)

**Interfaces:**
- Consumes: `buildCurveCrossCandidates` from `./lib.js` (Task 1) — exact signature above.
- Produces: nothing new consumed by a later task — Task 3 only touches config and on-chain state, not this file again.

- [ ] **Step 1: Replace `resolveCurveCandidates`**

Replace the entire function currently at `off-chain-bot/index.js:667-697`:

```javascript
async function resolveCurveCrossCandidates(curveAdapters, genericAdapters, borrowedAsset, provider, { amount, minProfit, slippageBps, feeTiers }) {
  const candidates = [];
  for (const { address } of curveAdapters) {
    const curveAdapterContract = new ethers.Contract(address, ['function POOL() view returns (address)'], provider);
    const poolAddress = await curveAdapterContract.POOL();
    const pool = new ethers.Contract(poolAddress, CURVE_POOL_ABI, provider);
    const [coin0, coin1] = await Promise.all([pool.coins(0), pool.coins(1)]);

    const borrowedLower = borrowedAsset.toLowerCase();
    let otherToken, curveIOut, curveJOut;
    if (coin0.toLowerCase() === borrowedLower) {
      [otherToken, curveIOut, curveJOut] = [coin1, 0, 1];
    } else if (coin1.toLowerCase() === borrowedLower) {
      [otherToken, curveIOut, curveJOut] = [coin0, 1, 0];
    } else {
      log.info(`curve adapter ${address}: pool trades ${coin0}/${coin1}, doesn't include BORROWED_ASSET -- skipping`);
      continue;
    }

    candidates.push(
      ...buildCurveCrossCandidates({
        curveAdapterAddress: address,
        genericAdapters,
        borrowedAsset,
        otherToken,
        curveIOut,
        curveJOut,
        feeTiers,
        amount,
        minProfit,
        slippageBps,
      })
    );
  }
  return candidates;
}
```

Note: this drops the old same-pool round-trip candidate entirely (it can never be profitable) and instead delegates to `buildCurveCrossCandidates`, paired against every configured generic adapter.

- [ ] **Step 2: Add `buildCurveCrossCandidates` to the existing `lib.js` import**

`off-chain-bot/index.js` imports from `./lib` via destructuring, currently at lines 43-54:

```javascript
const {
  GENERIC_PROTOCOLS,
  encodeCurveRouteData,
  parseAdapterList,
  parseAddressList,
  parseFeeTiers,
  buildTwoLegCandidates,
  buildTriangularCandidates,
  hopKey,
  applyHopChain,
  findOptimalTradeSize,
} = require('./lib');
```

Add `buildCurveCrossCandidates` to this list (e.g. right after `buildTriangularCandidates`), so the unprefixed call in Step 1 resolves correctly.

- [ ] **Step 3: Update `buildCandidates()`'s call site**

In `off-chain-bot/index.js`, find `buildCandidates()` (currently at line 858-874). Its current body ends with:

```javascript
  if (config.curveAdapters.length > 0) {
    candidates.push(...(await resolveCurveCandidates(config.curveAdapters, config.borrowedAsset, provider, config)));
  }
  return candidates;
}
```

Replace just that `if` block with:

```javascript
  if (config.curveAdapters.length > 0) {
    candidates.push(...(await resolveCurveCrossCandidates(config.curveAdapters, config.genericAdapters, config.borrowedAsset, provider, config)));
  }
  return candidates;
}
```

(`config.genericAdapters` and `config.feeTiers` already exist on the config object produced by `loadScanConfig()` — no changes needed there.)

- [ ] **Step 4: Run the full existing test suite**

Run: `cd off-chain-bot && npm test`
Expected: PASS — all of Task 1's new tests plus every pre-existing test in `lib.test.js`, unchanged and still green. `index.js` itself has no automated tests (by design — see `lib.js`'s own header comment on the pure/impure split), so this step is the full verification available before Task 3's live check.

- [ ] **Step 5: Commit**

```bash
cd /home/chrismerilo88/dex-arbitrage-bot
git add off-chain-bot/index.js
git commit -m "feat: pair Curve legs against generic adapters instead of the same pool"
```

---

### Task 3: Deploy the Curve adapter and reconfigure Ethereum Mainnet

**Files:**
- Modify: `off-chain-bot/.env.mainnet` (`BORROWED_ASSET`, `VIA_TOKENS`, `ADAPTERS`)
- Modify: `notes/03 - Address Registry.md` (record the new deployment, matching the BiSwap precedent's write-up style)

**Interfaces:**
- Consumes: Task 2's `resolveCurveCrossCandidates` (exercised live by the restarted scanner, not called directly by this task).

- [ ] **Step 1: Confirm the compiled `CurveAdapter` artifact exists**

Run: `cd /home/chrismerilo88/dex-arbitrage-bot && forge build 2>&1 | tail -5`
Expected: `Compiler run successful!` (or no output if already cached — either way, confirm the artifact exists next)

Run: `ls out/CurveAdapter.sol/CurveAdapter.json`
Expected: the file exists

- [ ] **Step 2: Check deployer balance and current gas price before broadcasting**

Run (as a script file, not an inline multi-command string, to avoid shell-complexity issues):

```bash
cat > /tmp/check-eth-mainnet-gas.sh <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
cast balance 0xD692484B3263dFb3c18fBaA545a4fcff38DFaB32 --rpc-url https://eth-mainnet.g.alchemy.com/v2/alch_4Wz9Gg2U_QDh9oyM9lOhm --ether
cast gas-price --rpc-url https://eth-mainnet.g.alchemy.com/v2/alch_4Wz9Gg2U_QDh9oyM9lOhm
EOF
bash /tmp/check-eth-mainnet-gas.sh
```

Expected: a balance comfortably above what ~600,000 gas at the printed gas price would cost (deploy + 1 adapter approval + 2 token approvals). At the last check (2026-08-13), balance was `0.004748696878154194` ETH and gas price `57807797` wei (~0.058 Gwei) — comfortably enough. If gas price has since spiked by orders of magnitude, stop and report back rather than broadcasting into an unknown cost.

- [ ] **Step 3: Deploy `CurveAdapter` pointed at the real 3pool**

```bash
cat > /tmp/deploy-curve-adapter.sh <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
cd /home/chrismerilo88/dex-arbitrage-bot
ADAPTER_BYTECODE=$(forge inspect CurveAdapter bytecode)
ADAPTER_ARGS=$(cast abi-encode "constructor(address)" 0xbEbc44782C7dB0a1A60Cb6fe97d0b483032FF1C7)
ADAPTER_FULL="${ADAPTER_BYTECODE}${ADAPTER_ARGS#0x}"
PRIVATE_KEY=$(grep "^PRIVATE_KEY=" off-chain-bot/.env.mainnet | cut -d= -f2-)
cast send --private-key "$PRIVATE_KEY" --rpc-url https://eth-mainnet.g.alchemy.com/v2/alch_4Wz9Gg2U_QDh9oyM9lOhm --create "$ADAPTER_FULL"
EOF
bash /tmp/deploy-curve-adapter.sh
```

Expected: a receipt with `status 1 (success)` and a `contractAddress`. Record that address — every step below refers to it as `<CURVE_ADAPTER>`.

- [ ] **Step 4: Verify the deployment live**

```bash
cast call <CURVE_ADAPTER> "POOL()(address)" --rpc-url https://eth-mainnet.g.alchemy.com/v2/alch_4Wz9Gg2U_QDh9oyM9lOhm
```

Expected: returns exactly `0xbEbc44782C7dB0a1A60Cb6fe97d0b483032FF1C7`. If it doesn't match, stop — do not proceed to approval with a misconfigured adapter.

- [ ] **Step 5: Approve the adapter in the executor**

```bash
cat > /tmp/approve-curve-adapter.sh <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
PRIVATE_KEY=$(grep "^PRIVATE_KEY=" /home/chrismerilo88/dex-arbitrage-bot/off-chain-bot/.env.mainnet | cut -d= -f2-)
cast send --private-key "$PRIVATE_KEY" --rpc-url https://eth-mainnet.g.alchemy.com/v2/alch_4Wz9Gg2U_QDh9oyM9lOhm 0x03e22682AA1e319E55598B89A3366083b2d28051 "approveAdapter(address,bool)" <CURVE_ADAPTER> true
EOF
bash /tmp/approve-curve-adapter.sh
```

(Replace `<CURVE_ADAPTER>` with the real address from Step 3 before running.) Expected: `status 1 (success)`.

- [ ] **Step 6: Approve DAI and USDT as new tokens** (USDC is already approved — confirmed live: `isTokenApproved(USDC)` returns `true` today)

```bash
cat > /tmp/approve-dai-usdt.sh <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
PRIVATE_KEY=$(grep "^PRIVATE_KEY=" /home/chrismerilo88/dex-arbitrage-bot/off-chain-bot/.env.mainnet | cut -d= -f2-)
EXECUTOR=0x03e22682AA1e319E55598B89A3366083b2d28051
RPC=https://eth-mainnet.g.alchemy.com/v2/alch_4Wz9Gg2U_QDh9oyM9lOhm
cast send --private-key "$PRIVATE_KEY" --rpc-url "$RPC" "$EXECUTOR" "approveToken(address,bool)" 0x6B175474E89094C44Da98b954EedeAC495271d0F true
cast send --private-key "$PRIVATE_KEY" --rpc-url "$RPC" "$EXECUTOR" "approveToken(address,bool)" 0xdAC17F958D2ee523a2206206994597C13D831ec7 true
EOF
bash /tmp/approve-dai-usdt.sh
```

Expected: both `status 1 (success)`.

- [ ] **Step 7: Confirm approvals took effect immediately**

`approvalDelay()` on this executor is confirmed `0` (checked live 2026-08-13), so no cooldown wait is needed — but confirm rather than assume:

```bash
cat > /tmp/verify-approvals.sh <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
EXECUTOR=0x03e22682AA1e319E55598B89A3366083b2d28051
RPC=https://eth-mainnet.g.alchemy.com/v2/alch_4Wz9Gg2U_QDh9oyM9lOhm
echo "adapter approved: $(cast call $EXECUTOR 'isAdapterApproved(address)(bool)' <CURVE_ADAPTER> --rpc-url $RPC)"
echo "DAI approved: $(cast call $EXECUTOR 'isTokenApproved(address)(bool)' 0x6B175474E89094C44Da98b954EedeAC495271d0F --rpc-url $RPC)"
echo "USDT approved: $(cast call $EXECUTOR 'isTokenApproved(address)(bool)' 0xdAC17F958D2ee523a2206206994597C13D831ec7 --rpc-url $RPC)"
echo "maxLoanAmount (must stay 0): $(cast call $EXECUTOR 'maxLoanAmount()(uint256)' --rpc-url $RPC)"
EOF
bash /tmp/verify-approvals.sh
```

(Replace `<CURVE_ADAPTER>` with the real address.) Expected: all three approvals `true`, `maxLoanAmount` still `0`.

- [ ] **Step 8: Reconfigure `off-chain-bot/.env.mainnet`**

Current file:
```
ADAPTERS=0x7400889e29Dd8E3a9667050571F2c87feDfa7450:v3
BORROWED_ASSET=0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2
VIA_TOKENS=0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48
```

Replace with (substituting the real `<CURVE_ADAPTER>` address from Step 3):

```
ADAPTERS=0x7400889e29Dd8E3a9667050571F2c87feDfa7450:v3,<CURVE_ADAPTER>:curve
BORROWED_ASSET=0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48
VIA_TOKENS=0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2
```

(`BORROWED_ASSET` is now USDC where it used to be the `VIA_TOKENS` entry; the old `BORROWED_ASSET`, WETH, moves into `VIA_TOKENS` in its place -- keeps the existing WETH<->USDC Uniswap V3 scanning surface, just re-rooted at USDC.)

- [ ] **Step 9: Restart the scanner and verify live**

```bash
systemctl --user restart dex-arbitrage-scanner-mainnet.service
sleep 10
journalctl --user -u dex-arbitrage-scanner-mainnet.service -n 30 --no-pager
```

Expected: no startup errors, `scanning N candidate route(s)...` where N is visibly larger than before this change (previously 9 candidates per the `.env.mainnet` comment about the pre-filter), and at least some candidates return real quotes (not all reverting) — confirms the Curve legs are producing real, callable routes rather than silently failing every time.

- [ ] **Step 10: Record the deployment in the Address Registry**

Add a new subsection to `notes/03 - Address Registry.md`'s Ethereum Mainnet section (matching the exact style of the "Second DEX added (2026-08-14): BiSwap" subsection already in the BNB Chain section) covering: the `CurveAdapter` address, the `BORROWED_ASSET` change and why, confirmation that `maxLoanAmount` stayed `0` throughout, and the before/after candidate count from Step 9.

- [ ] **Step 11: Clean up temp scripts and commit**

```bash
rm -f /tmp/check-eth-mainnet-gas.sh /tmp/deploy-curve-adapter.sh /tmp/approve-curve-adapter.sh /tmp/approve-dai-usdt.sh /tmp/verify-approvals.sh
cd /home/chrismerilo88/dex-arbitrage-bot
git add off-chain-bot/.env.mainnet "notes/03 - Address Registry.md"
git commit -m "feat: deploy Curve adapter, reconfigure Ethereum Mainnet for stablecoin arb"
```

Note: `off-chain-bot/.env.mainnet` is gitignored (confirmed — it holds a real private key), so `git add` on it will be a no-op if so; if it turns out not to be gitignored, stop and check with the user before committing a file containing `PRIVATE_KEY` rather than committing it automatically.

---

## Self-Review

**Spec coverage:** `buildCurveCrossCandidates` pure/2-leg-only/both-directions (Task 1) ✓. `resolveCurveCandidates` replaced, same-pool round trip dropped (Task 2, Step 1) ✓. `buildCandidates()` call site updated with `config.genericAdapters` (Task 2, Step 3) ✓. `prefilterCandidates`/`rankCandidates`/`tryRoute` untouched (no task modifies them) ✓. `BORROWED_ASSET` WETH→USDC, WETH moved to `VIA_TOKENS` (Task 3, Step 8) ✓. Curve adapter deployment + adapter/token approvals + `maxLoanAmount` reconfirmed `0` (Task 3, Steps 3-7) ✓. Registry documentation (Task 3, Step 10) ✓. Arbitrum/BNB unaffected — no task touches their `.env.*` files or `resolveCurveCrossCandidates`'s behavior when `curveAdapters` is empty (unchanged: empty loop, returns `[]`) ✓.

**Placeholder scan:** No TBD/TODO. `<CURVE_ADAPTER>` in Task 3 is a real placeholder for a value that doesn't exist until Step 3 runs — explicitly called out as "record that address" and substituted in every subsequent step, not a plan gap.

**Type consistency:** `buildCurveCrossCandidates`'s parameter names (`curveAdapterAddress`, `genericAdapters`, `borrowedAsset`, `otherToken`, `curveIOut`, `curveJOut`, `feeTiers`, `amount`, `minProfit`, `slippageBps`) match exactly between Task 1's implementation, Task 1's tests, and Task 2's call site in `resolveCurveCrossCandidates`. `config.genericAdapters`/`config.curveAdapters`/`config.feeTiers` verified against the actual `loadScanConfig()` return shape before writing this plan, not assumed.
