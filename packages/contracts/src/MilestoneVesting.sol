// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @notice Minimal interface for Uniswap V3 pool TWAP observation
interface IUniswapV3Pool {
    function observe(uint32[] calldata secondsAgos)
        external
        view
        returns (int56[] memory tickCumulatives, uint160[] memory secondsPerLiquidityCumulativeX128s);
}

/// @notice Interface to read cumulative settlement from MiningRewards
interface IMiningRewards {
    function cumulativeSettledUsdc() external view returns (uint256);
}

/**
 * @title MilestoneVesting
 * @notice Tesla-style milestone-based token vesting for the CLAW team allocation.
 *         Four milestones must each be sustained for 30 consecutive days before
 *         the corresponding tranche of tokens unlocks.
 * @dev    Conditions checked: 30-day TWAP price, pool USDC depth, and
 *         cumulative protocol settlement volume.
 */
contract MilestoneVesting is Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ============ Types ============

    struct MilestoneConfig {
        uint256 unlockPercent;      // e.g. 10 = 10%
        uint256 twapThreshold;      // price with 18 decimals
        uint256 depthThreshold;     // USDC (6 decimals) required in pool
        uint256 settledThreshold;   // cumulative USDC settled (6 decimals)
    }

    // ============ State ============

    IERC20 public immutable clawToken;
    IUniswapV3Pool public immutable uniswapPool;
    IMiningRewards public immutable miningRewards;
    address public immutable beneficiary;

    /// @notice Total CLAW tokens deposited into the vesting contract
    uint256 public totalDeposited;

    /// @notice Total CLAW tokens already claimed by the beneficiary
    uint256 public totalClaimed;

    /// @dev 4 milestone configs (indices 0-3)
    MilestoneConfig[4] public milestones;

    /// @dev Consecutive days each milestone's conditions have been met
    mapping(uint256 => uint256) public daysMetConsecutively;

    /// @dev Whether each milestone has been reached (all 30 days passed)
    mapping(uint256 => bool) public milestoneReached;

    /// @dev Last timestamp a daily check was recorded per milestone
    mapping(uint256 => uint256) public lastCheckTimestamp;

    /// @dev Seconds in 30 days, used for TWAP window
    uint32 private constant TWAP_WINDOW = 30 days;

    /// @dev Minimum interval between two daily checks (23 hours to allow jitter)
    uint256 private constant CHECK_INTERVAL = 23 hours;

    /// @dev Number of consecutive passing days required
    uint256 private constant DAYS_REQUIRED = 30;

    // ============ Events ============

    event MilestoneReached(uint256 indexed milestoneId);
    event TokensClaimed(address indexed beneficiary, uint256 amount);
    event TokensDeposited(address indexed depositor, uint256 amount);

    // ============ Errors ============

    error InvalidMilestoneId();
    error MilestoneAlreadyReached();
    error TooSoonForDailyCheck();
    error NotBeneficiary();
    error NothingToClaim();

    // ============ Constructor ============

    /**
     * @param _clawToken     CLAW ERC-20 address
     * @param _uniswapPool   Uniswap V3 CLAW/USDC pool address
     * @param _miningRewards MiningRewards contract address
     * @param _beneficiary   Address that will receive unlocked tokens
     */
    constructor(
        address _clawToken,
        address _uniswapPool,
        address _miningRewards,
        address _beneficiary
    ) Ownable(msg.sender) {
        require(_clawToken != address(0), "zero clawToken");
        require(_uniswapPool != address(0), "zero uniswapPool");
        require(_miningRewards != address(0), "zero miningRewards");
        require(_beneficiary != address(0), "zero beneficiary");

        clawToken = IERC20(_clawToken);
        uniswapPool = IUniswapV3Pool(_uniswapPool);
        miningRewards = IMiningRewards(_miningRewards);
        beneficiary = _beneficiary;

        // Milestone 1: 10% unlock
        milestones[0] = MilestoneConfig(10, 0.01e18, 100_000e6, 100_000e6);
        // Milestone 2: 20% unlock
        milestones[1] = MilestoneConfig(20, 0.05e18, 500_000e6, 1_000_000e6);
        // Milestone 3: 30% unlock
        milestones[2] = MilestoneConfig(30, 0.10e18, 2_000_000e6, 10_000_000e6);
        // Milestone 4: 40% unlock
        milestones[3] = MilestoneConfig(40, 0.50e18, 5_000_000e6, 50_000_000e6);
    }

    // ============ Deposit ============

    /**
     * @notice Lock CLAW tokens into this vesting contract
     * @param amount Number of CLAW tokens to deposit (18 decimals)
     */
    function depositTokens(uint256 amount) external nonReentrant {
        require(amount > 0, "zero amount");
        clawToken.safeTransferFrom(msg.sender, address(this), amount);
        totalDeposited += amount;
        emit TokensDeposited(msg.sender, amount);
    }

    // ============ Daily Check ============

    /**
     * @notice Record a daily check for a milestone. Must be called once per day.
     *         If all conditions are met, increments the consecutive-day counter.
     *         30 consecutive passing days marks the milestone as reached.
     * @param milestoneId Index 0-3
     */
    function recordDailyCheck(uint256 milestoneId) external {
        if (milestoneId > 3) revert InvalidMilestoneId();
        if (milestoneReached[milestoneId]) revert MilestoneAlreadyReached();
        if (block.timestamp < lastCheckTimestamp[milestoneId] + CHECK_INTERVAL) {
            revert TooSoonForDailyCheck();
        }

        lastCheckTimestamp[milestoneId] = block.timestamp;

        MilestoneConfig memory m = milestones[milestoneId];

        bool twapOk = _getTwapPrice() >= m.twapThreshold;
        bool depthOk = _getPoolUsdcDepth() >= m.depthThreshold;
        bool settledOk = miningRewards.cumulativeSettledUsdc() >= m.settledThreshold;

        if (twapOk && depthOk && settledOk) {
            daysMetConsecutively[milestoneId] += 1;

            if (daysMetConsecutively[milestoneId] >= DAYS_REQUIRED) {
                milestoneReached[milestoneId] = true;
                emit MilestoneReached(milestoneId);
            }
        } else {
            daysMetConsecutively[milestoneId] = 0;
        }
    }

    // ============ Claim ============

    /**
     * @notice Claim all unlocked but unclaimed tokens
     */
    function claim() external nonReentrant {
        if (msg.sender != beneficiary) revert NotBeneficiary();

        uint256 totalUnlockPercent = 0;
        for (uint256 i = 0; i < 4; i++) {
            if (milestoneReached[i]) {
                totalUnlockPercent += milestones[i].unlockPercent;
            }
        }

        uint256 entitled = totalDeposited * totalUnlockPercent / 100;
        uint256 claimable = entitled - totalClaimed;
        if (claimable == 0) revert NothingToClaim();

        totalClaimed += claimable;
        clawToken.safeTransfer(beneficiary, claimable);

        emit TokensClaimed(beneficiary, claimable);
    }

    // ============ Internal Helpers ============

    /**
     * @dev Compute 30-day arithmetic-mean TWAP price from Uniswap V3 oracle.
     *      Returns a price value with 18 decimals.
     */
    function _getTwapPrice() internal view returns (uint256) {
        uint32[] memory secondsAgos = new uint32[](2);
        secondsAgos[0] = TWAP_WINDOW; // 30 days ago
        secondsAgos[1] = 0;           // now

        (int56[] memory tickCumulatives, ) = uniswapPool.observe(secondsAgos);

        // Arithmetic mean tick over the window
        int56 tickDelta = tickCumulatives[1] - tickCumulatives[0];
        int24 avgTick = int24(tickDelta / int56(int32(TWAP_WINDOW)));

        // Convert tick to price: price = 1.0001^tick
        // Using the formula: price = (1.0001e18)^tick approximation
        // For precision we use: price = 1e18 * 1.0001^tick
        // Approximation via exp: 1.0001^tick ~ e^(tick * ln(1.0001))
        // ln(1.0001) ~= 0.00009999500033 ~= 99995e-9 (scaled)
        // We compute e^x using a simple Taylor series for reasonable tick range

        bool negative = avgTick < 0;
        uint256 absTick = negative ? uint256(uint24(-avgTick)) : uint256(uint24(avgTick));

        // x = absTick * 99995 (ln(1.0001) * 1e9 ~ 99995)
        // result = e^(x / 1e9) * 1e18
        // Use precomputed ratio approach from Uniswap: ratio = (2^128) based
        uint256 ratio = absTick & 0x1 != 0 ? 0xfff97272373d413259a46990580e213a : 0x100000000000000000000000000000000;
        if (absTick & 0x2 != 0) ratio = (ratio * 0xfff2e50f5f656932ef12357cf3c7fdcc) >> 128;
        if (absTick & 0x4 != 0) ratio = (ratio * 0xffe5caca7e10e4e61c3624eaa0941cd0) >> 128;
        if (absTick & 0x8 != 0) ratio = (ratio * 0xffcb9843d60f6159c9db58835c926644) >> 128;
        if (absTick & 0x10 != 0) ratio = (ratio * 0xff973b41fa98c081472e6896dfb254c0) >> 128;
        if (absTick & 0x20 != 0) ratio = (ratio * 0xff2ea16466c96a3843ec78b326b52861) >> 128;
        if (absTick & 0x40 != 0) ratio = (ratio * 0xfe5dee046a99a2a811c461f1969c3053) >> 128;
        if (absTick & 0x80 != 0) ratio = (ratio * 0xfcbe86c7900a88aedcffc83b479aa3a4) >> 128;
        if (absTick & 0x100 != 0) ratio = (ratio * 0xf987a7253ac413176f2b074cf7815e54) >> 128;
        if (absTick & 0x200 != 0) ratio = (ratio * 0xf3392b0822b70005940c7a398e4b70f3) >> 128;
        if (absTick & 0x400 != 0) ratio = (ratio * 0xe7159475a2c29b7443b29c7fa6e889d9) >> 128;
        if (absTick & 0x800 != 0) ratio = (ratio * 0xd097f3bdfd2022b8845ad8f792aa5825) >> 128;
        if (absTick & 0x1000 != 0) ratio = (ratio * 0xa9f746462d870fdf8a65dc1f90e061e5) >> 128;
        if (absTick & 0x2000 != 0) ratio = (ratio * 0x70d869a156d2a1b890bb3df62baf32f7) >> 128;
        if (absTick & 0x4000 != 0) ratio = (ratio * 0x31be135f97d08fd981231505542fcfa6) >> 128;
        if (absTick & 0x8000 != 0) ratio = (ratio * 0x9aa508b5b7a84e1c677de54f3e99bc9) >> 128;
        if (absTick & 0x10000 != 0) ratio = (ratio * 0x5d6af8dedb81196699c329225ee604) >> 128;
        if (absTick & 0x20000 != 0) ratio = (ratio * 0x2216e584f5fa1ea926041bedfe98) >> 128;
        if (absTick & 0x40000 != 0) ratio = (ratio * 0x48a170391f7dc42444e8fa2) >> 128;

        if (!negative) ratio = type(uint256).max / ratio;

        // Convert from Q128.128 to price with 18 decimals
        // price = ratio * 1e18 >> 128
        uint256 price = (ratio * 1e18) >> 128;

        return price;
    }

    /**
     * @dev Read USDC balance of the Uniswap pool as a proxy for pool depth
     */
    function _getPoolUsdcDepth() internal view returns (uint256) {
        // USDC is the paired token in the pool; read its balance directly.
        // We hardcode the USDC address used by the protocol. In production
        // this would be set via constructor; here we use a standard approach.
        // The pool address itself holds the USDC reserves.
        // We read ERC-20 balanceOf the pool address.
        //
        // NOTE: The caller/deployer must ensure the pool uses USDC as one of
        // its tokens. This reads token1 balance (USDC) held by the pool.

        // We need the USDC address. We can get it from EscrowPool or store
        // it. For simplicity, we check how much of *any* non-CLAW token the
        // pool holds. A cleaner approach: read pool.token0/token1.
        // For now, we compute: total USDC in pool = balanceOf(pool) for USDC.
        // We'll read the pool's token0 and check which is CLAW vs USDC.

        // Minimal inline interface
        address poolAddr = address(uniswapPool);

        // Try to determine which token is USDC (the one that isn't CLAW)
        (bool ok0, bytes memory data0) = poolAddr.staticcall(
            abi.encodeWithSignature("token0()")
        );
        require(ok0, "token0 call failed");
        address token0 = abi.decode(data0, (address));

        (bool ok1, bytes memory data1) = poolAddr.staticcall(
            abi.encodeWithSignature("token1()")
        );
        require(ok1, "token1 call failed");
        address token1 = abi.decode(data1, (address));

        address usdcAddr = (token0 == address(clawToken)) ? token1 : token0;
        return IERC20(usdcAddr).balanceOf(poolAddr);
    }

    // ============ View ============

    /**
     * @notice Check how many consecutive days a milestone has passed
     * @param milestoneId Index 0-3
     * @return days Number of consecutive passing days so far
     */
    function getDaysMetConsecutively(uint256 milestoneId) external view returns (uint256) {
        return daysMetConsecutively[milestoneId];
    }

    /**
     * @notice Check whether a specific milestone has been reached
     * @param milestoneId Index 0-3
     * @return reached True if the milestone conditions held for 30 days
     */
    function isMilestoneReached(uint256 milestoneId) external view returns (bool) {
        return milestoneReached[milestoneId];
    }
}
