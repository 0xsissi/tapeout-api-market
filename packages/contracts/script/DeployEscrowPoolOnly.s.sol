// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Script.sol";

import {EscrowPool} from "../src/EscrowPool.sol";
import {MiningRewards} from "../src/MiningRewards.sol";

contract DeployEscrowPoolOnly is Script {
    function run() external returns (EscrowPool escrowPool) {
        address usdc = vm.envAddress("USDC_ADDRESS");
        address treasury = vm.envAddress("TREASURY_ADDRESS");
        address miningRewardsAddr = vm.envAddress("MINING_REWARDS_ADDRESS");

        vm.startBroadcast();

        escrowPool = new EscrowPool(usdc, treasury, miningRewardsAddr);
        MiningRewards(miningRewardsAddr).setAuthorisedCaller(address(escrowPool), true);

        vm.stopBroadcast();

        console2.log("EscrowPool:", address(escrowPool));
    }
}
