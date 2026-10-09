// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
import "forge-std/Script.sol";
import {TestBEM} from "../src/TestBEM.sol";
import {BEMEscrowPool} from "../src/BEMEscrowPool.sol";

contract DeployBEMTestnet is Script {
    function run() external returns (TestBEM token, BEMEscrowPool pool) {
        require(block.chainid == 97, "BEM test deployment requires BSC testnet");
        address treasury = vm.envAddress("TREASURY_ADDRESS");
        require(treasury != address(0), "treasury required");
        vm.startBroadcast();
        token = new TestBEM();
        pool = new BEMEscrowPool(address(token), treasury);
        vm.stopBroadcast();
        console2.log("TestBEM:", address(token));
        console2.log("BEMEscrowPool:", address(pool));
    }
}
