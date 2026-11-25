# Implementation decisions

Where the PRD was silent, ambiguous, or (in one case) unsafe as written, this is what we chose and why. PRD statements are quoted. Everything else is our assumption.

## Security corrections

### D1. `gatewaySig` is verified on-chain; `Service` gains an immutable `gateway` field
The PRD's `Attestation` struct carries a `gatewaySig`, but the `settleBatch` step list never verifies it. `settleBatch` is permissionless, and the seller signature only covers `{callId, responseHash, deliveredValue}`. Without the fix, **anyone (including the buyer) could resubmit a real seller signature with `arrival` rewritten to the far future and force a refund.** The fix: `ClauseEscrow` verifies an EIP-712 `GatewayAttestation{callId, responseHash, deliveredValue, arrival, statusOK}` against `Service.gateway`, an immutable field set at registration. Test: *"nobody can rewrite arrival/statusOK on a permissionless settle"*.

### D2. Failure-path attestation when the seller is dead
PRD step 2 requires a seller signature, but a killed seller can't sign anything. That would make the headline demo ("kill a seller's API → refund lands with zero human action") wait for voucher expiry. Our choice: if `statusOK == false` **and** `sellerSig` is empty, the escrow accepts a gateway-only attestation, but only with `responseHash == 0` and `deliveredValue == 0`. This stays inside the PRD §8 trust boundary, because the gateway is already the trusted party for `statusOK`. Every template ANDs `statusOK`, so this path can **only** refund, never pay. Tests: *"seller dead…"*, *"failure attestation must zero the delivery fields"*, *"statusOK=true without a seller signature is rejected"*.

### D3. `reclaim` requires the buyer's real signature
Otherwise anyone could void an arbitrary `callId` with a forged expired voucher and deny a seller payment for valid delivery (I4).

### D4. `MAX_VOUCHER_LIFETIME = 10 min` enforced on-chain
PRD: "Delayed withdraw: delay must exceed max voucher expiry (use 15 min)". We enforce `expiry − issuedAt ≤ 600 s` so the 15-minute withdraw delay always outlasts any voucher.

### D5. SSRF guard on seller upstream URLs
The gateway fetches seller-registered URLs. With `ALLOW_PRIVATE_UPSTREAMS=false` (default when `NODE_ENV=production`), loopback, private, link-local and CGNAT targets are refused at registration and before every fetch.

## Semantics the PRD left open

| # | Topic | Decision |
|---|---|---|
| D6 | What `reclaim` does to funds | Buyer funds are only debited at settlement, so before adjudication nothing is locked. `reclaim` voids the voucher and gives the call a terminal on-chain state (`Reclaimed`). It moves no tokens. |
| D7 | Where seller earnings go | Credited to the payee's internal escrow balance (pull model) and withdrawn via the same delayed withdraw. This avoids a reverting token transfer (blacklist, etc.) bricking a whole batch. |
| D8 | `feeBps` | Immutable constructor parameter of the escrow, copied into each `Service` at registration (so it's per-service immutable, PRD I5). Max 10%. Default 1% to a fixed `treasury`. |
| D9 | Bad items in a batch | Skipped with `Skipped(callId, reason)` and no state change; the rest of the batch settles. Only a length mismatch reverts the whole batch. |
| D10 | Order of steps 5 and 7 | The processor is evaluated before the debit, so a skipped item leaves no trace. The observable effect equals the PRD order, executed atomically. |
| D11 | `depositFor` | Added so a wallet-free demo agent can be funded on-chain by a faucet. It pulls from `msg.sender` and credits the beneficiary. Harmless. |
| D12 | Who picks `callId` | The gateway, at 402 time (random 32 bytes); the buyer signs it inside the voucher. Uniqueness is enforced on-chain. |
| D13 | Seller signs `{callId, responseHash, deliveredValue}` | Follows PRD §5 step 2. The architecture diagram also mentions `ts`, but `arrival` comes from the gateway attestation, so the seller doesn't sign a timestamp. |
| D14 | `statusOK` byte | The reference model treats only `0x01` as OK. Unresolved with the partner (see TAPE-X-INTEGRATION §9). |
| D15 | Plaintext quote | The 402 body includes `plaintextQuote` (UTF-8) and `plaintextQuoteB64` (exact bytes). The buyer client checks `hash8(bytes) == sealedHash` and, for JSON quotes with a `value` field, `value == quotedValue` before signing ("Buyer must approve the actual value before signing"). |
| D16 | Deadline | `deadline = quote time + service SLA` (seller-chosen, default 10 s; demo 3 s). `grace` is per-service and immutable. |
| D17 | Values | uint32 fixed-point with seller-chosen decimals (demo FX: 5 decimals). |
| D18 | Demo kill switch | Two scopes. **Global** closes the seller's API listener (connections are refused for everyone) and auto-revives after 2 min. **Session** makes the seller drop the socket for one demo session, so concurrent public visitors don't break each other. The sandbox uses session scope by default; `npm run agent -- --global` uses global. |
| D19 | Simulated mode | For a wallet-free, chain-free sandbox (PRD §7: "Simulated mode wallet-free"), a SQLite ledger mirrors `ClauseEscrow` step for step, including real EIP-712 recovery. It is labelled "simulated" everywhere, and its verdicts come from the reference model, never a circuit. |
| D20 | x402 headers | x402 v2-style `PAYMENT-REQUIRED` / `PAYMENT-SIGNATURE` / `PAYMENT-RESPONSE`, `scheme: "exact"`, `network: eip155:<chainId>`, `payTo: <escrow>`, plus `extensions.clause`. Deferred settlement is disclosed (PRD §6 "x402 honesty"). |
| D21 | Toolchain | Hardhat (no Foundry on the build machine), `evmVersion: paris`, OpenZeppelin pinned to 5.0.2 (later 5.x uses the Cancun `mcopy` opcode). Node's built-in `node:sqlite`, so there's no native DB dependency. |
