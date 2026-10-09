// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/token/ERC20/extensions/ERC20Permit.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

/** TAM testing currency, unrelated to Circle-issued USDC. */
contract TestUSDC is ERC20, ERC20Permit, Ownable {
    constructor() ERC20("TAM Test USDC", "tUSDC") ERC20Permit("TAM Test USDC") Ownable(msg.sender) {
        require(block.chainid == 97, "TestUSDC requires BSC testnet");
        _mint(msg.sender, 1_000_000 * 10 ** 6);
    }

    function decimals() public pure override returns (uint8) { return 6; }

    function mint(address to, uint256 amount) external onlyOwner {
        _mint(to, amount);
    }
}
