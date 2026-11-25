// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IClauseProcessor} from "../interfaces/IClauseProcessor.sol";

/// @title MockRuleProcessor — DEVELOPMENT MOCK. NOT A TAPED-OUT CIRCUIT.
/// @notice Behavioural Solidity model of the PRD §4 rule templates so ClauseEscrow can be
///         developed and tested before the partner's TapeOut processor and circuit IDs exist.
///         It must never be deployed to X Layer mainnet (scripts/deploy.cjs refuses).
///         Real verdicts come from the partner-owned processor; see docs/TAPE-X-INTEGRATION.md.
contract MockRuleProcessor is IClauseProcessor {
    string public constant NOTICE = "DEV MOCK: behavioural model of the PRD rules, not a taped-out circuit";
    uint256 public constant CIRCUIT_E = 1; // Template E — Exact
    uint256 public constant CIRCUIT_B = 2; // Template B — Band

    function eval(uint256 circuitId, bytes calldata input) external pure returns (uint8) {
        require(input.length == 41, "MockRuleProcessor: input must be 41 bytes");
        bool statusOK = uint8(input[28]) == 1;
        uint256 arrival = uint32(bytes4(input[16:20]));
        uint256 deadline = uint32(bytes4(input[20:24]));
        uint256 grace = uint32(bytes4(input[24:28]));
        bool onTime = arrival <= deadline + grace;

        if (circuitId == CIRCUIT_E) {
            bool hashMatch = bytes8(input[0:8]) == bytes8(input[8:16]);
            return (statusOK && hashMatch && onTime) ? 1 : 0;
        }
        if (circuitId == CIRCUIT_B) {
            uint256 delivered = uint32(bytes4(input[29:33]));
            uint256 quoted = uint32(bytes4(input[33:37]));
            uint256 tolerance = uint32(bytes4(input[37:41]));
            uint256 diff = delivered >= quoted ? delivered - quoted : quoted - delivered;
            return (statusOK && diff <= tolerance && onTime) ? 1 : 0;
        }
        revert("MockRuleProcessor: unknown circuit");
    }
}
