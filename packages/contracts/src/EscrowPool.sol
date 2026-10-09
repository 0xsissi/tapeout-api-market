// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/extensions/IERC20Permit.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import "@openzeppelin/contracts/utils/cryptography/EIP712.sol";

interface IMiningRewards {
    function recordSettlement(address provider, uint256 usdcAmount, uint256 qualityMultiplier) external;
}

contract EscrowPool is EIP712, Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    bytes32 public constant AUTHORIZATION_TYPEHASH = keccak256(
        "Authorization(address buyer,address seller,uint256 amount,uint256 nonce,uint256 expiresAt,bytes32 poolId)"
    );
    bytes32 public constant BITMAP_AUTHORIZATION_TYPEHASH = keccak256(
        "Authorization(address buyer,address seller,uint256 amount,uint256 nonce,uint256 expiresAt,bytes32 poolId,uint8 nonceMode)"
    );

    uint256 public constant WITHDRAW_DELAY = 48 hours;
    uint256 public constant MAX_BATCH_SIZE = 100;

    enum ClaimSkipReason {
        InvalidSeller,
        InvalidPoolId,
        Expired,
        BadNonce,
        BadSignature,
        InsufficientAvailableBalance
    }

    enum NonceMode {
        Sequential,
        Bitmap
    }

    struct Authorization {
        address buyer;
        address seller;
        uint256 amount;
        uint256 nonce;
        uint256 expiresAt;
        bytes32 poolId;
        uint8 nonceMode;
    }

    struct PendingWithdraw {
        uint256 amount;
        uint256 unlockAt;
    }

    IERC20 public immutable usdc;
    bytes32 public immutable POOL_ID;

    address public treasury;
    address public miningRewards;
    uint256 public protocolFeeBps = 100;
    uint256 public cumulativeSettledUsdc;
    uint256 public accruedProtocolFees;

    mapping(address => uint256) private balances;
    mapping(address => PendingWithdraw) public pendingWithdrawals;
    mapping(address => mapping(address => uint256)) public nonces;
    mapping(address => mapping(address => mapping(uint256 => uint256))) private nonceBitmaps;
    mapping(address => uint256) private slashingBond;

    event Deposit(address indexed buyer, uint256 amount);
    event Claimed(address indexed buyer, address indexed seller, uint256 amount, uint256 nonce);
    event ClaimSkipped(
        address indexed buyer,
        address indexed seller,
        uint256 amount,
        uint256 nonce,
        ClaimSkipReason reason
    );
    event WithdrawRequested(address indexed buyer, uint256 amount, uint256 unlockAt);
    event WithdrawCompleted(address indexed buyer, uint256 amount);
    event WithdrawCancelled(address indexed buyer, uint256 amount);
    event TreasuryUpdated(address treasury);
    event MiningRewardsUpdated(address miningRewards);
    event ProtocolFeeUpdated(uint256 feeBps);
    event ProtocolFeesAccrued(uint256 amount, uint256 totalAccrued);
    event ProtocolFeesWithdrawn(address indexed to, uint256 amount);

    error InvalidAmount();
    error PendingWithdrawExists();
    error NoPendingWithdraw();
    error WithdrawNotReady();
    error InsufficientAvailableBalance();
    error ArrayLengthMismatch();
    error BatchTooLarge();
    error InvalidFeeBps();

    constructor(address _usdc, address _treasury, address _miningRewards)
        EIP712("ClawEscrowPool", "1")
        Ownable(msg.sender)
    {
        require(_usdc != address(0), "zero usdc");
        usdc = IERC20(_usdc);
        treasury = _treasury;
        miningRewards = _miningRewards;
        POOL_ID = bytes32(uint256(uint160(address(this))));
    }

    function deposit(uint256 amount) external nonReentrant {
        _depositFrom(msg.sender, msg.sender, amount);
    }

    function depositFor(address buyer, uint256 amount) external nonReentrant {
        _depositFrom(msg.sender, buyer, amount);
    }

    function depositWithPermit(
        address buyer,
        uint256 amount,
        uint256 deadline,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external nonReentrant {
        try IERC20Permit(address(usdc)).permit(buyer, address(this), amount, deadline, v, r, s) {} catch {}
        _depositFrom(buyer, buyer, amount);
    }

    function requestWithdraw(uint256 amount) external returns (uint256 unlockAt) {
        if (amount == 0) revert InvalidAmount();
        if (pendingWithdrawals[msg.sender].unlockAt != 0) revert PendingWithdrawExists();
        if (amount > getWithdrawableBalance(msg.sender)) revert InsufficientAvailableBalance();

        unlockAt = block.timestamp + WITHDRAW_DELAY;
        pendingWithdrawals[msg.sender] = PendingWithdraw({amount: amount, unlockAt: unlockAt});

        emit WithdrawRequested(msg.sender, amount, unlockAt);
    }

    function completeWithdraw() external nonReentrant {
        PendingWithdraw memory request = pendingWithdrawals[msg.sender];
        if (request.unlockAt == 0) revert NoPendingWithdraw();
        if (block.timestamp < request.unlockAt) revert WithdrawNotReady();

        delete pendingWithdrawals[msg.sender];
        uint256 currentBalance = balances[msg.sender];
        uint256 actualAmount = request.amount > currentBalance ? currentBalance : request.amount;

        if (actualAmount > 0) {
            balances[msg.sender] -= actualAmount;
            usdc.safeTransfer(msg.sender, actualAmount);
        }

        emit WithdrawCompleted(msg.sender, actualAmount);
    }

    function cancelWithdraw() external {
        PendingWithdraw memory request = pendingWithdrawals[msg.sender];
        if (request.unlockAt == 0) revert NoPendingWithdraw();

        delete pendingWithdrawals[msg.sender];
        emit WithdrawCancelled(msg.sender, request.amount);
    }

    function claim(Authorization[] calldata auths, bytes[] calldata sigs) external nonReentrant {
        if (auths.length != sigs.length) revert ArrayLengthMismatch();
        if (auths.length > MAX_BATCH_SIZE) revert BatchTooLarge();

        uint256 sellerPayout;
        uint256 protocolFees;

        for (uint256 i = 0; i < auths.length; i++) {
            Authorization calldata auth = auths[i];

            if (auth.seller != msg.sender) {
                emit ClaimSkipped(auth.buyer, auth.seller, auth.amount, auth.nonce, ClaimSkipReason.InvalidSeller);
                continue;
            }
            if (auth.poolId != POOL_ID) {
                emit ClaimSkipped(auth.buyer, auth.seller, auth.amount, auth.nonce, ClaimSkipReason.InvalidPoolId);
                continue;
            }
            if (auth.expiresAt < block.timestamp) {
                emit ClaimSkipped(auth.buyer, auth.seller, auth.amount, auth.nonce, ClaimSkipReason.Expired);
                continue;
            }
            if (_hasBadNonce(auth, msg.sender)) {
                emit ClaimSkipped(auth.buyer, auth.seller, auth.amount, auth.nonce, ClaimSkipReason.BadNonce);
                continue;
            }
            if (!_isValidSignature(auth, sigs[i])) {
                emit ClaimSkipped(auth.buyer, auth.seller, auth.amount, auth.nonce, ClaimSkipReason.BadSignature);
                continue;
            }
            if (auth.amount > balances[auth.buyer]) {
                emit ClaimSkipped(
                    auth.buyer,
                    auth.seller,
                    auth.amount,
                    auth.nonce,
                    ClaimSkipReason.InsufficientAvailableBalance
                );
                continue;
            }

            balances[auth.buyer] -= auth.amount;
            _consumeNonce(auth, msg.sender);

            uint256 fee = auth.amount * protocolFeeBps / 10_000;
            protocolFees += fee;
            sellerPayout += auth.amount - fee;
            cumulativeSettledUsdc += auth.amount;

            if (miningRewards != address(0)) {
                try IMiningRewards(miningRewards).recordSettlement{gas: 100_000}(msg.sender, auth.amount, 100) {}
                catch {}
            }

            emit Claimed(auth.buyer, msg.sender, auth.amount, auth.nonce);
        }

        if (protocolFees > 0) {
            accruedProtocolFees += protocolFees;
            emit ProtocolFeesAccrued(protocolFees, accruedProtocolFees);
        }
        if (sellerPayout > 0) {
            usdc.safeTransfer(msg.sender, sellerPayout);
        }
    }

    function getClaimableBalance(address buyer) public view returns (uint256) {
        return balances[buyer];
    }

    function getWithdrawableBalance(address buyer) public view returns (uint256) {
        uint256 pending = pendingWithdrawals[buyer].amount;
        uint256 balance = balances[buyer];
        return balance > pending ? balance - pending : 0;
    }

    function getAvailableBalance(address buyer) public view returns (uint256) {
        return getWithdrawableBalance(buyer);
    }

    function getBalance(address buyer) external view returns (uint256) {
        return balances[buyer];
    }

    function getNonce(address buyer, address seller) external view returns (uint256) {
        return nonces[buyer][seller];
    }

    function isNonceUsed(address buyer, address seller, uint256 nonce) external view returns (bool) {
        return _isBitmapNonceUsed(buyer, seller, nonce);
    }

    function setTreasury(address _treasury) external onlyOwner {
        treasury = _treasury;
        emit TreasuryUpdated(_treasury);
    }

    function setMiningRewards(address _miningRewards) external virtual onlyOwner {
        miningRewards = _miningRewards;
        emit MiningRewardsUpdated(_miningRewards);
    }

    function setProtocolFeeBps(uint256 feeBps) external onlyOwner {
        if (feeBps > 10_000) revert InvalidFeeBps();
        protocolFeeBps = feeBps;
        emit ProtocolFeeUpdated(feeBps);
    }

    function withdrawProtocolFees(uint256 amount) external onlyOwner nonReentrant {
        if (treasury == address(0)) revert InvalidAmount();
        if (amount == 0 || amount > accruedProtocolFees) revert InvalidAmount();

        accruedProtocolFees -= amount;
        usdc.safeTransfer(treasury, amount);

        emit ProtocolFeesWithdrawn(treasury, amount);
    }

    function withdrawAllProtocolFees() external onlyOwner nonReentrant {
        if (treasury == address(0)) revert InvalidAmount();
        uint256 amount = accruedProtocolFees;
        if (amount == 0) {
            return;
        }

        accruedProtocolFees = 0;
        usdc.safeTransfer(treasury, amount);

        emit ProtocolFeesWithdrawn(treasury, amount);
    }

    function _isValidSignature(Authorization calldata auth, bytes calldata sig) internal view returns (bool) {
        bytes32 structHash;

        if (_nonceMode(auth) == NonceMode.Bitmap) {
            structHash = keccak256(
                abi.encode(
                    BITMAP_AUTHORIZATION_TYPEHASH,
                    auth.buyer,
                    auth.seller,
                    auth.amount,
                    auth.nonce,
                    auth.expiresAt,
                    auth.poolId,
                    auth.nonceMode
                )
            );
        } else {
            structHash = keccak256(
                abi.encode(
                    AUTHORIZATION_TYPEHASH,
                    auth.buyer,
                    auth.seller,
                    auth.amount,
                    auth.nonce,
                    auth.expiresAt,
                    auth.poolId
                )
            );
        }

        bytes32 digest = _hashTypedDataV4(structHash);
        (address signer, ECDSA.RecoverError err,) = ECDSA.tryRecover(digest, sig);
        return err == ECDSA.RecoverError.NoError && signer == auth.buyer;
    }

    function _depositFrom(address payer, address buyer, uint256 amount) internal {
        if (buyer == address(0)) revert InvalidAmount();
        if (amount == 0) revert InvalidAmount();

        uint256 beforeBalance = usdc.balanceOf(address(this));
        usdc.safeTransferFrom(payer, address(this), amount);
        require(usdc.balanceOf(address(this)) - beforeBalance == amount, "unsupported transfer fee");
        balances[buyer] += amount;

        emit Deposit(buyer, amount);
    }

    function _hasBadNonce(Authorization calldata auth, address seller) internal view returns (bool) {
        NonceMode mode = _nonceMode(auth);

        if (mode == NonceMode.Bitmap) {
            return _isBitmapNonceUsed(auth.buyer, seller, auth.nonce);
        }

        return auth.nonce <= nonces[auth.buyer][seller];
    }

    function _consumeNonce(Authorization calldata auth, address seller) internal {
        NonceMode mode = _nonceMode(auth);

        if (mode == NonceMode.Bitmap) {
            (uint256 wordIndex, uint256 bitMask) = _bitmapPosition(auth.nonce);
            nonceBitmaps[auth.buyer][seller][wordIndex] |= bitMask;
            return;
        }

        nonces[auth.buyer][seller] = auth.nonce;
    }

    function _isBitmapNonceUsed(address buyer, address seller, uint256 nonce) internal view returns (bool) {
        (uint256 wordIndex, uint256 bitMask) = _bitmapPosition(nonce);
        return nonceBitmaps[buyer][seller][wordIndex] & bitMask != 0;
    }

    function _bitmapPosition(uint256 nonce) internal pure returns (uint256 wordIndex, uint256 bitMask) {
        wordIndex = nonce >> 8;
        uint256 bitIndex = nonce & 0xff;
        bitMask = uint256(1) << bitIndex;
    }

    function _nonceMode(Authorization calldata auth) internal pure returns (NonceMode) {
        if (auth.nonceMode == uint8(NonceMode.Bitmap)) {
            return NonceMode.Bitmap;
        }

        return NonceMode.Sequential;
    }
}
