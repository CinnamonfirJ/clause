# Clause

**A refund layer for x402 machine payments on X Layer.** Sellers pick a rule template; it compiles to an immutable TapeOut circuit; that circuit — not a company — decides *pay* or *refund*.

> **Status:** the non-Tape-X MVP is built and tested end to end (simulated mode and a local EVM chain).
> The taped-out circuits, the real processor `eval` ABI, circuit IDs, X Layer mainnet deployment and DeWEB publishing are **partner-owned** and **not done** — see [docs/TAPE-X-INTEGRATION.md](docs/TAPE-X-INTEGRATION.md). Nothing in this repo claims a TapeOut integration that doesn't exist: every verdict is labelled with where it came from.

---

## Why this exists

An AI agent that pays for an API call over x402 loses the money the instant it's sent. If the API is down, returns garbage, or answers after the data went stale, there's no chargeback, no support desk the agent can email, and at fractions of a cent nobody would answer anyway. Today agents (and the people who fund them) cope by sticking to a handful of trusted providers, pre-paying small balances, or eating the loss. That caps what agents can safely buy.

Clause removes that fear without adding a referee:

- The **buyer** signs the exact terms it accepted (sealed quote hash, quoted value, tolerance, deadline) before anything is sent.
- The **seller** signs the hash and value of what it actually delivered.
- A **public, immutable circuit** gets 41 bytes and outputs one bit. `1` pays the seller, `0` refunds the buyer.
- The **escrow** has no owner and no rules of its own — *the contract routes on the chip's output; it holds no rules of its own.*

The moment that makes it click: **kill the seller mid-run and watch the refund land with nobody touching anything** — then open the receipt, see the 41 bytes, and flip one yourself in the rule tester. Sellers come back because a verifiable refund promise (and a badge) is a reason for agents to pick them over a cheaper unknown.

## Quick start (simulated mode — no wallet, no chain, no keys)

Requires **Node ≥ 22.13** (uses the built-in `node:sqlite`).

```powershell
npm install
npm run dev
```

Open <http://localhost:5173> → **Try it in 60 seconds** → Deposit → **Run 10 paid calls**. The seller is killed at call 6; calls 6–10 are refunded by the crank within ~2 s.

Simulated mode uses a SQLite ledger that mirrors `ClauseEscrow` step-for-step (including real EIP-712 recovery) and the **reference model** of the rules for verdicts. Every screen says so.

### Local chain mode (real EVM, real contract, DEV MOCK processor)

```powershell
npm run dev:chain
```

Starts a Hardhat node on :8545, deploys `ClauseEscrow` + `MockUSD` + `MockRuleProcessor` (labelled DEV MOCK), runs the gateway in chain mode with Hardhat's public test keys and the web app. Receipts now carry real transaction hashes; the rule tester's **Verify on-chain** calls `ClauseEscrow.previewVerdict`.

### Terminal agent (video beat 0:20–1:10)

```powershell
npm run agent -- --gateway http://localhost:8787 --calls 10 --kill-at 6
```

## Architecture

```
Agent ──HTTP x402──> Gateway ──────────> Seller API (demo FX seller)
  │  402 + plaintext   │  /quote, /deliver   seller signs {callId, responseHash, deliveredValue}
  │  quote + seal      │  gateway attests {arrival, statusOK} (EIP-712)
  │  signs EIP-712     ▼
  │  voucher         Crank ── settleBatch / reclaim (permissionless)
  ▼                    ▼
ClauseEscrow ──staticcall eval(circuitId, 41 bytes)──> TapeOut processor (partner) / DEV MOCK / reference model (simulated)
  └── verdict 1 → price − fee to payee, fee to treasury │ verdict 0 → buyer credited back
Frontend: static Vite/React build (hash routing, relative assets) → DeWEB / TapeKit (partner)
```

| Package | What | Key files |
|---|---|---|
| `packages/core` | Shared protocol: 41-byte codec, reference rule model, EIP-712 types, x402 buyer client, test vectors | `input.ts`, `rules.ts`, `eip712.ts`, `x402.ts`, `vectors.ts` |
| `packages/contracts` | `ClauseEscrow`, processor interface, dev mocks, deploy + processor cross-check scripts | `ClauseEscrow.sol`, `IClauseProcessor.sol`, `scripts/` |
| `packages/gateway` | Express gateway (x402), SQLite store, settlement adapters (simulated / chain), crank, demo FX seller, terminal agent | `gateway.ts`, `app.ts`, `crank.ts`, `settlement/*`, `demo-seller/seller.ts` |
| `packages/web` | 5 screens: Landing, Sandbox, Rule tester, Receipt, Seller console | `src/pages/*` |

**Data flow for one call.** `GET /v1/rate?pair=EURUSD` → gateway fetches the seller's quote bytes → `402` with `accepts[0]` (`scheme: exact`, `payTo: escrow`) and `extensions.clause` (`callId`, `plaintextQuote`, `sealedHash`, `quotedValue`, `tolerance`, `deadline`, `price`, `tier: 1`) → the buyer client verifies `hash8(plaintext) == sealedHash` and the value, signs a `Voucher` → retry with `PAYMENT-SIGNATURE` → gateway verifies signature, terms, balance and pending withdrawals, reserves the price → proxies `/deliver` → hashes raw bytes → verifies the seller's `SellerReceipt` signature → signs a `GatewayAttestation` → `200` + raw bytes + `PAYMENT-RESPONSE{callId, receiptURL}` (or `502` with a refund-pending note) → crank `settleBatch` → `Adjudicated(callId, circuitId, verdict, input)`.

**Trust boundary** (PRD §8, published verbatim on the landing page):

| Component | Trusted for | Can cheat? |
|---|---|---|
| Circuit | the verdict | No — sealed, public, replayable |
| Escrow | custody, routing | No — no owner, no admin path |
| Seller signature | response hash + delivered value | No — gateway cannot forge |
| Gateway | arrival time, statusOK | **Yes — the one remaining gap.** Roadmap: TLS attestation |
| Buyer voucher | commitment terms | No — gateway cannot swap terms |

**x402 honesty.** Standard 402 → signed payload → response flow, `exact`-shaped requirement + `clause` extension, but settlement is deferred to batch adjudication. This is a disclosed deviation; Clause does not claim full x402 spec compliance.

Design decisions and the two security corrections to the PRD (gateway signature verification, dead-seller failure path) are in [docs/DECISIONS.md](docs/DECISIONS.md). Requirement-by-requirement coverage is in [docs/TRACEABILITY.md](docs/TRACEABILITY.md).

## Setup reference

| Task | Command |
|---|---|
| Install | `npm install` |
| Configure | copy `.env.example` → `.env` (optional in simulated mode) |
| Database | automatic — SQLite file at `packages/gateway/data/clause-<mode>.db`, schema created on start |
| Dev (simulated) | `npm run dev` → web :5173, gateway :8787, demo seller :4100 (admin :4101) |
| Dev (local chain) | `npm run dev:chain` |
| Production-style single process | `npm run build && npm start` (gateway serves `packages/web/dist`) |
| Typecheck | `npm run typecheck` |
| All tests | `npm test` (core + contracts + gateway) |
| Chain e2e | `npm run test:e2e:chain` |
| Regenerate vectors | `npm run vectors` |
| Cross-check a processor | see [TAPE-X-INTEGRATION §7](docs/TAPE-X-INTEGRATION.md#7-replacing-the-mocks-with-the-real-implementation) |

### Deploying

1. Partner supplies `PROCESSOR_ADDRESS`, `CIRCUIT_ID_E`, `CIRCUIT_ID_B`; run `verify-processor.cjs` until it reports 0 mismatches.
2. `packages/contracts`: `npx hardhat run scripts/deploy.cjs --network xlayer` with `DEPLOYER_PRIVATE_KEY`, `TOKEN_ADDRESS`, `TREASURY_ADDRESS`, `REGISTER_DEMO_SERVICES=true`, `GATEWAY_ADDRESS`, `SELLER_SIGNER`, `SELLER_PAYEE`. The script refuses a DEV MOCK processor on public chains.
3. Gateway host: `SETTLEMENT_MODE=chain`, `DEPLOYMENT_FILE=packages/contracts/deployments/xlayer.json`, `GATEWAY_PRIVATE_KEY` (= `GATEWAY_ADDRESS`, funded with OKB for gas), `SELLER_PRIVATE_KEY`, `DEMO_FUNDER_PRIVATE_KEY` (holds the stablecoin for the wallet-free sandbox), `NODE_ENV=production`, `PUBLIC_URL`, `WEB_URL`. Put it behind TLS.
4. Frontend: `VITE_GATEWAY_URL=https://<gateway> npm run build -w @clause/web`, then publish `packages/web/dist` through DeWEB/TapeKit (partner).

## Demo walkthrough (≤ 3 min, matches PRD §12)

1. **0:00 Problem** — Landing: "An agent's money is gone the instant it's sent." Point at the live stats.
2. **0:20 Refund** — *Try it in 60 seconds* → Deposit → *Run 10 paid calls* (auto-kill at 6). Hands off: calls 1–5 go **Paid**, the ledger marks *seller API killed here*, calls 6–10 flip to **Refunded**, the red banner "Refund landed with zero human action" appears, balance shows 0.95. (Or the terminal agent, same thing.) In chain mode click the explorer tx.
3. **1:10 No rules of its own** — *Open refund receipt*: verdict 0, "Seller dropped the connection → statusOK = 0", the 41 bytes coloured by who committed them, three signatures recovered. Show `ClauseEscrow.sol` `_settle` → `_eval`. *Replay in rule tester* → click `1 · OK`, then `= quoted + tolerance` → verdict flips to 1 → *Verify on-chain*.
4. **1:50 Seller** — Seller console: Template B, tolerance in bps (shown as absolute), register, badge snippet, earnings/refund rate. *(Real-seller testimonial and $9 payment are business tasks — not in this repo.)*
5. **2:20 Map** — templates → FabX → DeWEB → TapeKit; Tier 1; roadmap (TLS attestation for arrival/statusOK).

| Beat | Works now | Needs partner |
|---|---|---|
| Kill → refund, zero human action | ✅ simulated + local chain | Mainnet: processor + circuit IDs + deploy |
| Receipt with inputs, verdict, circuit ID, tx link | ✅ (tx links in chain mode) | Real circuit ID + explorer on X Layer |
| Rule tester, wallet-free, verdict flips | ✅ | Netlist simulator engine (optional) |
| On-chain verify | ✅ local chain (dev mock) | TapeOut processor |
| Live URL on DeWEB / `tape://` name | static build ready | DeWEB publish |

## Testing & limitations

**Executed (all passing at time of writing):**

- `packages/core` — 12 tests: layout, codec round-trip, all 8 PRD mandatory vectors, ignored-byte ranges, overflow, EIP-712 recover/bind, plaintext-quote checks.
- `packages/contracts` — 30 tests: verdict routing, trust-boundary attacks (term swap, hash forgery, arrival rewrite, missing seller sig, malformed failure attestation, wrong signer), step 3/4 rejections, delayed withdraw, reclaim, immutability, **I1–I5 randomized invariants (150 ops)**, **10,008 vectors reference == processor via `previewVerdict`**. Measured: `settleBatch(10)` = 655,815 gas (65,581/call) **with the DEV MOCK processor** — the real eval cost is partner-measured.
- `packages/gateway` — 16 tests: real HTTP gateway + real demo seller: 402 shape, happy path, session kill → refund, global kill (nothing charged), tamper → refund (E), drift → refund (B), unfunded agent refused, idempotent voucher replay, swapped terms rejected, buyer rejects bad seal, timeout reclaim, rule tester, stats/badge, registration validation + SSRF block, ABI sync.
- Chain e2e — hardhat node + deployed escrow + gateway in chain mode: 3 paid + 1 killed call settle in one tx; on-chain `callStatus`, balances and `previewVerdict` agreement asserted.
- Browser — full judge path (landing → sandbox → kill → receipt → rule tester) in ~25 s; 375 px layout with no horizontal scroll.

**Limitations / not done:**

- No taped-out circuit, no real processor ABI, no X Layer deployment (partner-owned). Mainnet evidence in `SUBMISSION.md` is empty on purpose.
- The gateway is trusted for `arrival` and `statusOK` (PRD §8 — the one remaining gap).
- PRD §10 optimistic-settlement fallback is not implemented (conditional on partner gas numbers).
- Delayed withdraw has no UI (contract only; not one of the 5 screens).
- Seller console in chain mode needs a browser wallet; it's tested at the API level, not with a real wallet.
- The demo FX seller serves **synthetic** rates.
- Rate limiting is in-memory per process; a multi-instance deploy would need a shared limiter.
