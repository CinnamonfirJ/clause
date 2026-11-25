// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @title MockUSD — DEVELOPMENT MOCK stablecoin (6 decimals, open mint). Local/testnet only.
/// @notice On X Layer mainnet use the canonical stablecoin chosen in PRD §9 #5 (USDC, or USDT/USDG fallback).
contract MockUSD is ERC20 {
    constructor() ERC20("Clause Dev USD (mock)", "cdUSD") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}
