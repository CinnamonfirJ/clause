# Tape X integration handoff

This document is for the partner implementing the **TapeOut / X Layer ("Tape X")** side of Clause. It covers what already exists, where your work plugs in, and what we still have to agree on.

> **Scope assumption, please confirm.** The PRD never uses the words "Tape X". We read it as the TapeOut-platform work on X Layer:
> rule-template **netlists**, **tape-out via FabX**, the on-chain **processor `eval`**, **circuit IDs**, **eval gas measurement**,
> **Circuit Verifier cross-checks**, and **DeWEB / TapeKit publishing**. Everything else (escrow, vouchers, gateway, seller, crank,
> frontend, docs) is implemented on the Clause side. If the split is different, tell us and we'll move the boundary.

---

## 1. What is implemented on the Clause side

| Piece | Where | Status |
|---|---|---|
| `ClauseEscrow` (no owner / upgrade / pause / admin withdrawal) | `packages/contracts/contracts/ClauseEscrow.sol` | Implemented; 30 Hardhat tests incl. invariant fuzz |
| Processor interface (the boundary) | `packages/contracts/contracts/interfaces/IClauseProcessor.sol` | **Assumed, [VERIFY]** |
| 41-byte input builder | `ClauseEscrow._buildInput`, `packages/core/src/input.ts`, `packages/core/src/settle.ts` | Implemented per PRD §4, **[VERIFY]** |
| Reference model of Templates E and B | `packages/core/src/rules.ts` | Implemented (a behavioural model, **not** a circuit) |
| 10,008 test vectors (8 mandatory + 10k random) | `packages/core/vectors/vectors.json` (`npm run vectors`) | Implemented |
| Processor cross-check tool | `packages/contracts/scripts/verify-processor.cjs` | Implemented; runs against any processor |
| DEV MOCK processor | `packages/contracts/contracts/dev-mocks/MockRuleProcessor.sol` | Local or test only; deploy script refuses it on public chains |
| Gateway, demo seller, crank, receipts, rule tester API | `packages/gateway` | Implemented |
| Frontend (5 screens), static build | `packages/web` → `packages/web/dist` | Implemented; DeWEB publish is yours |

## 2. What is yours

1. **Template E netlist** (≈800 NAND, combinational, 0 LATCH): `statusOK AND hashMatch AND arrival ≤ deadline + grace`.
2. **Template B netlist** (≈1,350 NAND): `statusOK AND |delivered − quoted| ≤ tolerance AND arrival ≤ deadline + grace`.
3. Tape-out of both via FabX on **X Layer (chainId 196)**, giving the **processor address** and **two circuit IDs**.
4. PRD §9 #1–#3: the real `eval` signature, encoding, return type, gas for ~800 and ~1,350 gates, processor address and circuit-ID format.
5. Netlist-level verification: exhaustive on reduced-width variants, the 10k vectors, and the ecosystem Circuit Verifier cross-check (PRD §4).
6. PRD §9 #4 and #6: confirm the Canvas target is X Layer, and run the **DeWEB publish flow → `tape://` name**, served via **TapeKit**.
7. The PRD §10 fallback decision (optimistic settlement) **if** measured eval gas makes per-call settlement untenable. See §9 below.

## 3. Integration points (the only places that change)

### 3.1 On-chain: `ClauseEscrow._eval`

```solidity
// packages/contracts/contracts/ClauseEscrow.sol
function _eval(address processor, uint256 circuitId, bytes memory input) internal view returns (bool ok, uint8 verdict) {
    (bool success, bytes memory ret) =
        processor.staticcall(abi.encodeCall(IClauseProcessor.eval, (circuitId, input)));
    if (!success || ret.length < 32) return (false, 0);
    uint256 raw = abi.decode(ret, (uint256));
    return (true, raw == 1 ? 1 : 0);
}
```

Assumed today ([VERIFY]): `function eval(uint256 circuitId, bytes calldata input) external view returns (uint8)`.

- If the name, argument types or return encoding differ, edit `IClauseProcessor.sol` and `_eval`. Nothing else in the contract depends on the processor ABI.
- If `eval` is **not `view`** (for example it writes state or charges a fee), `staticcall` will fail and every item will be skipped with `ProcessorCallFailed`. Switch to `call` in `_eval`, and make `previewVerdict` a non-view function or drop it. This is the most important ABI question.
- Any return value other than exactly `1` is treated as `0` (refund). A processor revert or a non-contract processor gives `Skipped(callId, ProcessorCallFailed)`, moves no funds, and the call is reclaimed after expiry.

### 3.2 Input layout: `_buildInput` + `packages/core/src/input.ts`

Big-endian, `abi.encodePacked` order, 41 bytes:

| Offset | Bytes | Field | Source |
|---|---|---|---|
| 0 | 8 | responseHash (SHA-256 of raw body, first 8 bytes) | seller-signed attestation |
| 8 | 8 | sealedHash | buyer voucher |
| 16 | 4 | arrival (uint32 unix) | gateway attestation |
| 20 | 4 | deadline | buyer voucher |
| 24 | 4 | grace | service registration |
| 28 | 1 | statusOK (encoder writes only 0x00 / 0x01) | gateway attestation |
| 29 | 4 | deliveredValue | seller-signed attestation |
| 33 | 4 | quotedValue | buyer voucher |
| 37 | 4 | tolerance | buyer voucher |

If the real circuit expects a different bit or byte order, change **both** `_buildInput` and `encodeInput` / `decodeInput` and re-run the vectors. The contract test `emits replayable Adjudicated` and the gateway ABI test catch drift between the two.

### 3.3 Off-chain verdict engine (gateway / rule tester)

`packages/core/src/rules.ts` exports a `RuleEngine` interface:

```ts
interface RuleEngine {
  id: string;
  kind: 'reference-model' | 'netlist-sim' | 'onchain';
  evaluate(template: TemplateId, circuitId: string, input: Uint8Array): Promise<0 | 1>;
}
```

`GET /v1/rule/:serviceId/test` currently reports `engine.kind = "reference-model"`. To add your gas-free **netlist simulator** (PRD §6 "Local netlist sim"), implement a `RuleEngine` with `kind: 'netlist-sim'` and call it from `ruleTest` in `packages/gateway/src/app.ts`. The response shape already has a slot for the engine label. `?onchain=1` already calls `ClauseEscrow.previewVerdict` → your processor.

### 3.4 Configuration (no code changes)

| Variable | Used by | Meaning |
|---|---|---|
| `PROCESSOR_ADDRESS` | deploy script, gateway | TapeOut processor on X Layer |
| `CIRCUIT_ID_E`, `CIRCUIT_ID_B` | deploy script, gateway | Taped-out circuit IDs (format **[VERIFY]**: we store them as `uint256`) |
| `TAPEOUT_URL_E`, `TAPEOUT_URL_B` | gateway → seller console and receipts | Public link to each circuit ("tape-out link", PRD §7) |
| `TOKEN_ADDRESS` | deploy, gateway | Canonical stablecoin (PRD §9 #5: USDC, or USDT/USDG fallback) |
| `XLAYER_RPC_URL`, `EXPLORER_URL` | deploy, gateway | RPC and explorer for tx links |

When `PROCESSOR_ADDRESS` and the circuit IDs are set on a non-mock deployment, the UI shows **"Taped-out circuit"** instead of "Dev mock" or "Reference model".

## 4. Confirmed contracts vs assumptions

| Item | Status |
|---|---|
| Template rules E and B (PRD §4 table) | **Confirmed by PRD** |
| 41-byte layout and field sources | PRD-specified, but the PRD marks it **[VERIFY against real eval ABI]** |
| Output: 1 bit, 1 = pay, 0 = refund | **Confirmed by PRD** |
| Tolerance is an absolute uint32, computed off-chain from bps | **Confirmed by PRD** |
| `eval(uint256,bytes) view returns (uint8)` | **Assumption** |
| Circuit ID is a `uint256` | **Assumption** |
| `statusOK` byte semantics for values other than 0/1 | **Unresolved** (reference model: only `0x01` is OK) |
| `deadline + grace` evaluated without uint32 overflow (33-bit) | **Assumption** (vectors include near-`2^32` cases) |
| Big-endian field encoding | **Assumption** |

## 5. Expected behaviour, errors and loading states

- **Verdict 1** → `Paid(callId, …)`, then `Adjudicated(callId, circuitId, 1, input)`. Receipt shows *Paid*.
- **Verdict 0** → `Refunded(…)`, then `Adjudicated(…, 0, input)`. Receipt shows *Refunded*.
- **Processor reverts or returns <32 bytes** → `Skipped(callId, 11 /*ProcessorCallFailed*/)`. The gateway retries up to 5 times, then the crank calls `reclaim` after voucher expiry. Receipt shows *Awaiting reclaim*, then *Reclaimed*. **No funds move on a skip.**
- **Rule tester `?onchain=1`** while the processor is unavailable → `{ onchain: { available: false, reason } }`, and the UI shows the reason. It never shows a fabricated on-chain verdict.
- **Simulated mode** (no chain) labels every verdict "Clause reference model (simulated — not the taped-out circuit)".

## 6. Development mocks (all clearly labelled, all replaceable)

| Mock | Location | Replaced by |
|---|---|---|
| `MockRuleProcessor` (circuit 1 = E, 2 = B; exposes `NOTICE()` = "DEV MOCK…") | `contracts/dev-mocks/` | Your processor address + circuit IDs via env. `deploy.cjs` **refuses** any processor whose `NOTICE()` contains "DEV MOCK" on a non-local chain |
| `MockUSD` (6-decimals, open mint) | `contracts/dev-mocks/` | Canonical stablecoin `TOKEN_ADDRESS` |
| Simulated settlement (SQLite ledger + reference model) | `packages/gateway/src/settlement/simulated.ts` | `SETTLEMENT_MODE=chain` |

## 7. Replacing the mocks with the real implementation

```powershell
# 1. Cross-check your processor against the 10,008 vectors (read-only eth_calls, no gas)
npm run vectors
cd packages/contracts
$env:PROCESSOR_ADDRESS="0x…"; $env:CIRCUIT_ID_E="…"; $env:CIRCUIT_ID_B="…"
npx hardhat run scripts/verify-processor.cjs --network xlayer   # must report 0 mismatches, 0 errors

# 2. Deploy the escrow against the real processor
$env:DEPLOYER_PRIVATE_KEY="0x…"; $env:TOKEN_ADDRESS="0x…"; $env:TREASURY_ADDRESS="0x…"; $env:FEE_BPS="100"
$env:REGISTER_DEMO_SERVICES="true"; $env:GATEWAY_ADDRESS="0x…"; $env:SELLER_SIGNER="0x…"; $env:SELLER_PAYEE="0x…"
npx hardhat run scripts/deploy.cjs --network xlayer             # writes deployments/xlayer.json

# 3. Point the gateway at it
$env:SETTLEMENT_MODE="chain"; $env:DEPLOYMENT_FILE="packages/contracts/deployments/xlayer.json"
$env:TAPEOUT_URL_E="…"; $env:TAPEOUT_URL_B="…"
npm start
```

## 8. Testing the completed integration

1. `verify-processor.cjs` with **0 mismatches** on all 10,008 vectors. This is the PRD's "local sim must equal on-chain eval".
2. Optionally `ESCROW_ADDRESS=… SERVICE_ID_E=… SERVICE_ID_B=…` with the same script, to go through `ClauseEscrow.previewVerdict` (the exact settlement path).
3. Fork test (PRD milestone Nov 25–26, "chain verdict moves funds"): run the gateway in chain mode against X Layer (or a fork), then `npm run agent -- --calls 10 --kill-at 6`. Expect 5 `Paid` and 5 `Refunded` events, with tx links on every receipt.
4. Rule tester → **Verify on-chain** must say "matches" for the PRD presets.
5. Record measured `settleBatch` gas per call in `SUBMISSION.md`. With the DEV MOCK it's **65,581 gas/call** in a batch of 10. Your processor adds its own eval cost on top.

## 9. Unresolved decisions (need agreement)

1. **`eval` ABI and mutability** (§3.1). This decides `staticcall` vs `call`, and whether `previewVerdict` stays a `view`.
2. **Circuit ID format** (uint256? bytes32? string?).
3. **`statusOK` byte semantics** for values other than 0/1 (LSB? any non-zero? exactly 1?).
4. **Endianness and bit order** of the 41-byte input inside the netlist.
5. **Gas fallback (PRD §10).** If eval gas is too high for micropayments, switch to optimistic settlement: release after a challenge window, eval on-chain only for contested calls. This changes `settleBatch` and is **not** implemented. PRD: "Decide once, then stop deliberating."
6. **EVM version.** Contracts compile with `evmVersion: paris` and OpenZeppelin 5.0.2 (no `mcopy`/`PUSH0` assumptions) until X Layer opcode support is confirmed.
7. **DeWEB / TapeKit.** `packages/web` builds to a static `dist/` with relative asset paths and hash routing, so it should work from any container path. The gateway URL is set at build time via `VITE_GATEWAY_URL`. The gateway sends permissive CORS headers and exposes `PAYMENT-RESPONSE`.
