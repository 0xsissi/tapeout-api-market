// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/**
 * @title ClawToken
 * @notice ERC-20 token for the ClawMarket decentralized AI API marketplace
 * @dev Fixed supply of 1 billion tokens, all minted at deployment and
 *      distributed to five allocation pools. No additional minting.
 */
contract ClawToken is ERC20 {
    /// @notice Total supply: 1 billion tokens (18 decimals)
    uint256 public constant TOTAL_SUPPLY = 1_000_000_000e18;

    // Allocation percentages (basis of 100)
    uint256 private constant MINING_POOL_PCT = 40;
    uint256 private constant TEAM_PCT = 20;
    uint256 private constant ECOSYSTEM_PCT = 15;
    uint256 private constant LIQUIDITY_PCT = 15;
    uint256 private constant RESERVE_PCT = 10;

    /**
     * @notice Deploy the CLAW token and distribute the entire supply
     * @param miningPool  Address receiving 40% for Proof-of-Settlement mining
     * @param team        Address receiving 20% for the team allocation
     * @param ecosystem   Address receiving 15% for ecosystem growth
     * @param liquidity   Address receiving 15% for DEX liquidity
     * @param reserve     Address receiving 10% for protocol reserve
     */
    constructor(
        address miningPool,
        address team,
        address ecosystem,
        address liquidity,
        address reserve
    ) ERC20("ClawMarket Token", "CLAW") {
        require(miningPool != address(0), "zero miningPool");
        require(team != address(0), "zero team");
        require(ecosystem != address(0), "zero ecosystem");
        require(liquidity != address(0), "zero liquidity");
        require(reserve != address(0), "zero reserve");

        _mint(miningPool, TOTAL_SUPPLY * MINING_POOL_PCT / 100);
        _mint(team, TOTAL_SUPPLY * TEAM_PCT / 100);
        _mint(ecosystem, TOTAL_SUPPLY * ECOSYSTEM_PCT / 100);
        _mint(liquidity, TOTAL_SUPPLY * LIQUIDITY_PCT / 100);
        _mint(reserve, TOTAL_SUPPLY * RESERVE_PCT / 100);
    }
}
