// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
import "forge-std/Script.sol";
import {BEMEscrowPool} from "../src/BEMEscrowPool.sol";

contract DeployBEMEscrowPool is Script {
    function run() external returns (BEMEscrowPool pool) {
        require(block.chainid == 56, "BEM deployment requires BSC");
        address treasury = vm.envAddress("TREASURY_ADDRESS");
        require(treasury != address(0), "treasury required");
        // Deployment signer is supplied to Forge externally; this script never reads a key.
        vm.startBroadcast();
        pool = new BEMEscrowPool(0x5ce033B2bFCa3Af30b3e8C8457DeaF776A8b695a, treasury);
        vm.stopBroadcast();
        console2.log("BEMEscrowPool:", address(pool));
    }
}
