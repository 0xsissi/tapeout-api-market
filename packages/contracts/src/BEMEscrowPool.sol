// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "./EscrowPool.sol";
import "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";

/** BEM-denominated pool. USDC mining cannot be attached to raw BEM volume. */
contract BEMEscrowPool is EscrowPool {
    constructor(address bem, address feeTreasury) EscrowPool(bem, feeTreasury, address(0)) {
        require(IERC20Metadata(bem).decimals() == 8, "BEM requires 8 decimals");
    }

    function settlementToken() external view returns (address) {
        return address(usdc); // usdc() remains an ABI compatibility alias
    }

    function setMiningRewards(address rewards) external override onlyOwner {
        require(rewards == address(0), "BEM mining disabled");
        miningRewards = address(0);
        emit MiningRewardsUpdated(address(0));
    }
}
