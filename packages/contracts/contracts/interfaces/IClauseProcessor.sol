// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title IClauseProcessor — integration boundary with the TapeOut circuit processor.
/// @notice PARTNER-OWNED (TapeOut / "Tape X"). The PRD marks this signature [VERIFY]:
///         "processor.eval(circuitId, input) → verdict". The real processor's function
///         name, argument encoding, return type and mutability are NOT confirmed.
///         ClauseEscrow calls it in exactly one place (`_eval`) via a low-level staticcall,
///         so adapting to the real ABI is a one-function change.
interface IClauseProcessor {
    /// @param circuitId Taped-out circuit identifier (format unconfirmed).
    /// @param input     41-byte unified input (PRD §4).
    /// @return verdict  1 = pay seller, 0 = refund buyer.
    function eval(uint256 circuitId, bytes calldata input) external view returns (uint8 verdict);
}
