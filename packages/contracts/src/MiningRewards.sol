// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/**
 * @title MiningRewards
 * @notice "Proof of Settlement" mining — distributes CLAW tokens to API
 *         providers proportional to the USDC they settle through EscrowPool.
 * @dev    Reward rate decreases across four phases as cumulative settlement
 *         volume grows. Quality multiplier (100-based) boosts or penalises
 *         individual settlements.
 */
contract MiningRewards is Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ============ State ============
    IERC20 public immutable clawToken;
    mapping(address => bool) public authorisedCallers;

    /// @notice Cumulative USDC settled across all channels (6 decimals)
    uint256 public cumulativeSettledUsdc;

    /// @notice Total CLAW rewards distributed so far (18 decimals)
    uint256 public totalRewardsDistributed;

    // ============ Phase thresholds (USDC 6 decimals) & rates ============
    uint256 private constant PHASE_1_LIMIT = 1_000_000e6;   // $1 M
    uint256 private constant PHASE_2_LIMIT = 5_000_000e6;   // $5 M
    uint256 private constant PHASE_3_LIMIT = 20_000_000e6;  // $20 M

    uint256 private constant RATE_PHASE_1 = 100; // 1 USDC → 100 CLAW
    uint256 private constant RATE_PHASE_2 = 50;
    uint256 private constant RATE_PHASE_3 = 25;
    uint256 private constant RATE_PHASE_4 = 10;

    /// @dev 1e12 bridges the 6-decimal USDC amount to 18-decimal CLAW amount
    uint256 private constant DECIMAL_BRIDGE = 1e12;

    // ============ Events ============
    event RewardDistributed(
        address indexed provider,
        uint256 usdcAmount,
        uint256 clawReward,
        uint256 phase,
        uint256 qualityMultiplier
    );

    // ============ Errors ============
    error OnlyAuthorisedCaller();

    // ============ Constructor ============

    /**
     * @param _clawToken   Address of the CLAW ERC-20 token
     * @param _initialAuthorisedCaller Initial authorised contract address
     */
    constructor(
        address _clawToken,
        address _initialAuthorisedCaller
    ) Ownable(msg.sender) {
        require(_clawToken != address(0), "zero clawToken");
        require(_initialAuthorisedCaller != address(0), "zero authorised caller");
        clawToken = IERC20(_clawToken);
        authorisedCallers[_initialAuthorisedCaller] = true;
    }

    // ============ Modifiers ============

    modifier onlyAuthorisedCaller() {
        if (!authorisedCallers[msg.sender]) revert OnlyAuthorisedCaller();
        _;
    }

    // ============ Core ============

    /**
     * @notice Record a settlement and distribute CLAW mining rewards
     * @dev    Only callable by an authorised settlement contract.
     * @param provider          The API provider (seller) to reward
     * @param usdcAmount        Settlement amount in USDC (6 decimals)
     * @param qualityMultiplier Quality score * 100 (e.g. 150 = 1.5x)
     */
    function recordSettlement(
        address provider,
        uint256 usdcAmount,
        uint256 qualityMultiplier
    ) external onlyAuthorisedCaller nonReentrant {
        uint256 rate = getCurrentRate();
        uint256 phase = getCurrentPhase();

        // reward = usdcAmount * rate * qualityMultiplier / 100 * DECIMAL_BRIDGE
        uint256 clawReward = usdcAmount * rate * qualityMultiplier * DECIMAL_BRIDGE / 100;

        // Update cumulative before transfer
        cumulativeSettledUsdc += usdcAmount;

        // Transfer reward if contract has sufficient balance; skip silently otherwise
        uint256 available = clawToken.balanceOf(address(this));
        if (clawReward > 0 && available >= clawReward) {
            clawToken.safeTransfer(provider, clawReward);
            totalRewardsDistributed += clawReward;
        }

        emit RewardDistributed(provider, usdcAmount, clawReward, phase, qualityMultiplier);
    }

    // ============ View Functions ============

    /**
     * @notice Remaining CLAW tokens available for mining rewards
     * @return balance CLAW balance held by this contract
     */
    function remainingRewards() external view returns (uint256) {
        return clawToken.balanceOf(address(this));
    }

    /**
     * @notice Current mining phase (1-4) based on cumulative settlement
     * @return phase The active phase number
     */
    function getCurrentPhase() public view returns (uint256) {
        if (cumulativeSettledUsdc < PHASE_1_LIMIT) return 1;
        if (cumulativeSettledUsdc < PHASE_2_LIMIT) return 2;
        if (cumulativeSettledUsdc < PHASE_3_LIMIT) return 3;
        return 4;
    }

    /**
     * @notice Current reward rate (CLAW per 1 USDC, before quality adjustment)
     * @return rate Tokens per USDC unit settled
     */
    function getCurrentRate() public view returns (uint256) {
        uint256 phase = getCurrentPhase();
        if (phase == 1) return RATE_PHASE_1;
        if (phase == 2) return RATE_PHASE_2;
        if (phase == 3) return RATE_PHASE_3;
        return RATE_PHASE_4;
    }

    // ============ Admin ============

    /**
     * @notice Add or remove an authorised settlement caller
     * @param caller Settlement contract address
     * @param isAuthorised Whether this caller should be allowed
     */
    function setAuthorisedCaller(address caller, bool isAuthorised) external onlyOwner {
        require(caller != address(0), "zero address");
        authorisedCallers[caller] = isAuthorised;
    }
}
