// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Script.sol";

import {ClawToken} from "../src/ClawToken.sol";
import {MiningRewards} from "../src/MiningRewards.sol";
import {EscrowPool} from "../src/EscrowPool.sol";
import {MilestoneVesting} from "../src/MilestoneVesting.sol";

contract DeployBaseSepolia is Script {
    struct DeployConfig {
        address deployer;
        address usdc;
        address treasury;
        address team;
        address ecosystem;
        address liquidity;
        address reserve;
        address milestoneBeneficiary;
        address uniswapPool;
        bool deployVesting;
    }

    function run() external returns (
        ClawToken clawToken,
        MiningRewards miningRewards,
        EscrowPool escrowPool,
        MilestoneVesting milestoneVesting
    ) {
        DeployConfig memory config = _loadConfig();
        uint256 deployerNonce = vm.getNonce(config.deployer);
        address predictedMiningRewards = _computeCreateAddress(config.deployer, deployerNonce + 1);

        vm.startBroadcast();

        clawToken = new ClawToken(
            predictedMiningRewards,
            config.team,
            config.ecosystem,
            config.liquidity,
            config.reserve
        );

        miningRewards = new MiningRewards(address(clawToken), config.deployer);
        escrowPool = new EscrowPool(config.usdc, config.treasury, address(miningRewards));

        miningRewards.setAuthorisedCaller(address(escrowPool), true);
        miningRewards.setAuthorisedCaller(config.deployer, false);

        if (config.deployVesting) {
            milestoneVesting = new MilestoneVesting(
                address(clawToken),
                config.uniswapPool,
                address(miningRewards),
                config.milestoneBeneficiary
            );
        }

        vm.stopBroadcast();

        console2.log("ClawToken:", address(clawToken));
        console2.log("MiningRewards:", address(miningRewards));
        console2.log("EscrowPool:", address(escrowPool));
        if (config.deployVesting) {
            console2.log("MilestoneVesting:", address(milestoneVesting));
        } else {
            console2.log("MilestoneVesting: skipped");
        }
    }

    function _loadConfig() internal view returns (DeployConfig memory config) {
        config.deployer = vm.envAddress("DEPLOYER_ADDRESS");
        config.usdc = vm.envAddress("USDC_ADDRESS");
        config.treasury = vm.envAddress("TREASURY_ADDRESS");
        config.team = vm.envOr("TEAM_ADDRESS", config.treasury);
        config.ecosystem = vm.envOr("ECOSYSTEM_ADDRESS", config.treasury);
        config.liquidity = vm.envOr("LIQUIDITY_ADDRESS", config.treasury);
        config.reserve = vm.envOr("RESERVE_ADDRESS", config.treasury);
        config.deployVesting = vm.envOr("DEPLOY_VESTING", false);
        config.uniswapPool = vm.envOr("UNISWAP_POOL_ADDRESS", address(0));
        config.milestoneBeneficiary = vm.envOr("MILESTONE_BENEFICIARY", config.team);

        if (config.deployVesting) {
            require(config.uniswapPool != address(0), "missing UNISWAP_POOL_ADDRESS");
            require(config.milestoneBeneficiary != address(0), "missing MILESTONE_BENEFICIARY");
        }
    }

    function _computeCreateAddress(address deployer, uint256 nonce) internal pure returns (address) {
        if (nonce == 0x00) {
            return address(uint160(uint256(keccak256(abi.encodePacked(
                bytes1(0xd6),
                bytes1(0x94),
                deployer,
                bytes1(0x80)
            )))));
        }

        if (nonce <= 0x7f) {
            return address(uint160(uint256(keccak256(abi.encodePacked(
                bytes1(0xd6),
                bytes1(0x94),
                deployer,
                uint8(nonce)
            )))));
        }

        if (nonce <= 0xff) {
            return address(uint160(uint256(keccak256(abi.encodePacked(
                bytes1(0xd7),
                bytes1(0x94),
                deployer,
                bytes1(0x81),
                uint8(nonce)
            )))));
        }

        if (nonce <= 0xffff) {
            return address(uint160(uint256(keccak256(abi.encodePacked(
                bytes1(0xd8),
                bytes1(0x94),
                deployer,
                bytes1(0x82),
                uint16(nonce)
            )))));
        }

        if (nonce <= 0xffffff) {
            return address(uint160(uint256(keccak256(abi.encodePacked(
                bytes1(0xd9),
                bytes1(0x94),
                deployer,
                bytes1(0x83),
                uint24(nonce)
            )))));
        }

        return address(uint160(uint256(keccak256(abi.encodePacked(
            bytes1(0xda),
            bytes1(0x94),
            deployer,
            bytes1(0x84),
            uint32(nonce)
        )))));
    }
}
