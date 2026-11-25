# SUBMISSION — evidence (PRD §13)

Fill these in only with real, verifiable values. **Do not** substitute local / simulated results for mainnet evidence.

| Item | Value | Owner | Status |
|---|---|---|---|
| Processor contract address (X Layer) | — | Partner (TapeOut) | pending |
| Circuit ID — Template E | — | Partner | pending |
| Circuit ID — Template B | — | Partner | pending |
| ClauseEscrow address (X Layer 196) | — | Clause (deploy after the above) | pending |
| `tape://` name | — | Partner (DeWEB) | pending |
| Gateway URL | — | Clause | pending |
| Features used | circuit adjudication, FabX, DeWEB, TapeKit | — | — |

## Rubric → evidence

| Rubric item | Evidence | Status |
|---|---|---|
| Refund tx (seller killed, zero human action) | explorer link | pending mainnet |
| Payment tx | explorer link | pending mainnet |
| Measured gas | `settleBatch(10)` = 655,815 gas (65,581/call) with the **DEV MOCK** processor on Hardhat. Real eval gas: pending partner (PRD §9 #2) | partial |
| Fork tests | `npm run test:e2e:chain` (local hardhat; fork of X Layer pending processor) | local ✅ |
| Contract tests / invariants | `npm test -w @clause/contracts` — 30 passing incl. I1–I5 fuzz + 10,008 vectors | ✅ |
| Live links | — | pending deploy |

## Description

- **Product:** a refund layer for x402 machine payments; a public circuit decides pay or refund.
- **Users:** AI-agent operators buying paid APIs; API sellers who want agents to trust them.
- **Reach / revenue / retention:** — (business evidence; fill from real sellers only)
