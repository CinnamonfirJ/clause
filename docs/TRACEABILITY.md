# PRD traceability matrix

PRD requirement → implementation → user-facing behaviour → acceptance criterion → test coverage.

Status key: ✅ implemented and verified by an automated test or a browser run · 🟡 implemented, not fully verified · 🟦 partner-owned (Tape X) · ⛔ blocked on partner / external · ⬜ outside MVP (PRD "CUT" or not a build task).

## P0 scope (PRD §2)

| PRD requirement | Implementation | User-facing | Acceptance | Tests | Status |
|---|---|---|---|---|---|
| Two rule-template circuits taped out on X Layer | Reference model `core/src/rules.ts`; boundary `IClauseProcessor.sol`; cross-check `scripts/verify-processor.cjs` | Template picker, circuit status chip, rule tester | Local sim == on-chain eval for every vector | `core.test.ts` (8 mandatory vectors); `Vectors.test.cjs` (10,008 vs mock processor) | 🟦 netlists + tape-out · ✅ boundary + vectors |
| ClauseEscrow: no owner / upgrade / pause / admin withdrawal | `contracts/ClauseEscrow.sol` | Footer claim; trust table | ABI has no admin surface | `immutability & no admin path` | ✅ |
| EIP-712 vouchers, domain `{ClauseEscrow, 1, 196, escrow}` | `ClauseEscrow._voucherDigest`; `core/src/eip712.ts` | Agent signs in browser (sandbox) | Gateway can't swap terms | `gateway cannot swap commitment terms`; core EIP-712 test; e2e `swapped terms` | ✅ |
| Seller-signed attestations | `SellerReceipt` typed data; demo seller signs each delivery | Receipt §5 signatures | Gateway can't forge the hash | `gateway cannot forge the response hash` | ✅ |
| Gateway + demo FX seller | `gateway/src/gateway.ts`, `demo-seller/seller.ts` | `/v1/rate`, sandbox | 402 → voucher → 200 + PAYMENT-RESPONSE | `e2e.test.ts` (14 scenarios), `chain.e2e.ts` | ✅ |
| Batch crank | `gateway/src/crank.ts` | Refunds land without action | Settles attested calls each tick | e2e + chain e2e (3 paid + 1 refund in one tx) | ✅ |
| Timeout reclaim | `ClauseEscrow.reclaim`; crank reclaim pass | Receipt "Reclaimed" | Only after expiry, real buyer sig, blocks settlement | `timeout reclaim` (contract + e2e) | ✅ |
| Delayed withdraw (15 min > max voucher lifetime) | `requestWithdraw` / `executeWithdraw`, `MAX_VOUCHER_LIFETIME` | — (contract-level) | Post-request vouchers rejected; locked 15 min | `delayed withdraw` suite (3 tests) | ✅ contract · ⬜ no UI (not in the PRD's 5 screens) |
| 5 frontend screens on DeWEB | `packages/web` (static, hash-routed, relative assets) | Landing, Seller console, Sandbox, Rule tester, Receipt | Judge path < 60 s wallet-free | Browser run (desktop + 375 px) | ✅ screens · 🟦 DeWEB publish |
| Evidence README | `README.md`, `SUBMISSION.md` (evidence slots) | — | Rubric → evidence table | — | 🟡 slots for mainnet evidence pending |

## Contract details (PRD §5)

| Requirement | Where | Test |
|---|---|---|
| Step 1: voucher signer == buyer | `_settle` | `voucher signed by someone other than the buyer` |
| Step 2: sellerSig == service.signer | `_settle` | `gateway cannot forge the response hash` |
| Step 3: reject used / expired / maxAmount < price | `_settle` | `each callId resolves once`, `rejects after expiry`, `rejects maxAmount < price` |
| Step 4: reject if pending withdrawal and issuedAt > requestedAt | `_settle` | `vouchers issued after a withdraw request are rejected` |
| Steps 5–8: debit, build input, eval, route | `_settle`, `_buildInput`, `_eval` | `verdict 1 pays…`, `verdict 0 refunds…` |
| Step 9: `Adjudicated(callId, circuitId, verdict, fullInputBytes)` | `_settle` | Asserts exact 41 input bytes |
| `previewVerdict` | contract | `Vectors.test.cjs` |
| I1 Σbalances ≤ token balance | `totalBalance` | `Invariants.test.cjs` (150 random ops) |
| I2 each callId resolves once | `callStatus` | Invariants + unit |
| I3 funds move only via verdict / reclaim / withdraw | No other mutators | Invariants (reclaim moves nothing) + ABI test |
| I4 seller paid even if buyer vanishes | Permissionless settle | Invariants (stranger settles) + unit |
| I5 circuitId / payee / feeBps / grace immutable | No setters | Invariants (`getService` unchanged) |

## Circuit spec (PRD §4)

| Requirement | Where | Test |
|---|---|---|
| E: statusOK ∧ hashMatch ∧ arrival ≤ deadline + grace | `rules.ts`, `MockRuleProcessor` | Mandatory vectors 1–4 |
| B: statusOK ∧ \|Δ\| ≤ tol ∧ on time | same | Mandatory vectors 5–8 |
| E ignores bytes 29–40, B ignores 0–15 | `TEMPLATES[].ignored` | `Template E ignores…` |
| Tolerance absolute uint32 from bps, off-chain | `toleranceFromBps`, gateway quote | `toleranceFromBps floors`, e2e 402 test |
| Never canonicalize JSON | `hash8(raw bytes)` | `hash8 … no canonicalization` |
| 10k randomized vectors | `vectors.ts`, `gen-vectors.ts` | `Vectors.test.cjs` |
| Exhaustive reduced-width; Circuit Verifier | — | 🟦 netlist-level, partner |

## Gateway (PRD §6)

| Endpoint | Status | Test |
|---|---|---|
| `GET /v1/services`: template, price, circuit ID, refund rate | ✅ | `catalog lists both rule templates` |
| `GET /v1/rate?pair=` → 402 + accepts[] + extensions.clause{…, plaintextQuote, …, tier:1} | ✅ | `402 carries exact-shaped accepts[]…` |
| Retry + PAYMENT-SIGNATURE → verify → proxy → hash → seller sig → attest → 200 + PAYMENT-RESPONSE{callId, receiptURL} | ✅ | `happy path…` |
| `POST /internal/crank` | ✅ | e2e |
| `GET /v1/receipts/:callId`: inputs, verdict, circuit ID, tx links | ✅ | e2e + chain e2e (tx hash) |
| `GET /v1/rule/:serviceId/test`: gas-free | ✅ reference model · 🟦 netlist sim | `rule tester: flipping byte 28…` |
| `POST /demo/seller/kill` | ✅ (session + global) | `kill switch (session)`, `global kill` |
| Plaintext quote mandatory; buyer approves value before signing | ✅ | `checkQuote` tests; `buyer refuses a quote whose seal does not match` |
| x402 honesty in docs | ✅ README, landing page, 402 `extra.deviation` | — |

## Frontend (PRD §7)

| Screen | Must do | Status |
|---|---|---|
| Landing | One-line problem, live stats, "Try it in 60 seconds" | ✅ |
| Seller console | Pick E/B → params → tape-out link → badge snippet → earnings / refund rate | ✅ (tape-out link shows once the partner supplies `TAPEOUT_URL_*`) |
| Sandbox | Deposit → 10 calls → kill-switch → refund lands; simulated wallet-free | ✅ verified in browser: 5 paid / 5 refunded |
| Rule tester | Edit any of the 41 bytes → verdict flips live → optional on-chain verify | ✅ (on-chain verify verified in chain e2e) |
| Receipt | callId, all inputs, verdict, circuit ID, tx links | ✅ |
| Acceptance: landing → sandbox → kill → refund receipt → rule tester < 60 s, no wallet | ✅ browser run, about 25 s |

## Definition of done (PRD §1)

| Criterion | Status |
|---|---|
| Kill a seller's API mid-demo → refund lands **on mainnet** with zero human action | ✅ locally (simulated + local chain) · ⛔ mainnet needs the partner's processor + circuit IDs + deploy |
| A stranger tests the rule in a browser without a wallet | ✅ |
| One real seller has paid real money | ⬜ business task (seller outreach), not code |

## Explicitly outside MVP (PRD "CUT")

Tier 2, partial-refund tiers, human arbitration, token, multi-chain, mobile app, zkTLS, permissionless gateways, TapeSend/TapeRelay, formal x402 scheme registration, second service vertical. None of these were built. The PRD §10 optimistic-settlement fallback is conditional on the partner's gas measurement and is **not** implemented (see TAPE-X-INTEGRATION §9).
