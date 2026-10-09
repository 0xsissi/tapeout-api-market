// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

/** Test currency only: never deploy this token as the real BEM. */
contract TestBEM is ERC20, Ownable {
    constructor() ERC20("TAM Test BEM", "tBEM") Ownable(msg.sender) {
        require(block.chainid == 97, "TestBEM requires BSC testnet");
        _mint(msg.sender, 1_000_000 * 10 ** 8);
    }

    function decimals() public pure override returns (uint8) { return 8; }

    function mint(address to, uint256 amount) external onlyOwner {
        _mint(to, amount);
    }
}
