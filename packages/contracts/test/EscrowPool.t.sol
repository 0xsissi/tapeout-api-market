// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "../lib/openzeppelin-contracts/contracts/token/ERC20/ERC20.sol";
import "../lib/openzeppelin-contracts/contracts/token/ERC20/extensions/ERC20Permit.sol";
import "../lib/openzeppelin-contracts/lib/forge-std/src/Test.sol";
import "../src/EscrowPool.sol";

contract MockUSDC is ERC20, ERC20Permit {
    mapping(address => bool) public blockedRecipients;

    constructor() ERC20("Mock USDC", "USDC") ERC20Permit("Mock USDC") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function setBlockedRecipient(address recipient, bool blocked) external {
        blockedRecipients[recipient] = blocked;
    }

    function _update(address from, address to, uint256 value) internal override {
        if (to != address(0) && blockedRecipients[to]) revert("recipient blocked");
        super._update(from, to, value);
    }
}

contract BurnAllGasMiningRewards {
    function recordSettlement(address, uint256, uint256) external pure {
        assembly {
            invalid()
        }
    }
}

contract EscrowPoolTest is Test {
    bytes32 private constant DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    bytes32 private constant LEGACY_AUTHORIZATION_TYPEHASH =
        keccak256("Authorization(address buyer,address seller,uint256 amount,uint256 nonce,uint256 expiresAt,bytes32 poolId)");
    bytes32 private constant BITMAP_AUTHORIZATION_TYPEHASH =
        keccak256(
            "Authorization(address buyer,address seller,uint256 amount,uint256 nonce,uint256 expiresAt,bytes32 poolId,uint8 nonceMode)"
        );
    bytes32 private constant PERMIT_TYPEHASH =
        keccak256("Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)");

    uint256 private constant BUYER_PK = 0xA11CE;
    uint256 private constant CLAIM_AMOUNT = 50_000;
    uint256 private constant INITIAL_DEPOSIT = 500_000_000;

    MockUSDC private usdc;
    EscrowPool private pool;
    address private buyer;
    address private seller;
    address private sellerB;
    address private treasury;
    address private sponsor;

    function setUp() public {
        buyer = vm.addr(BUYER_PK);
        seller = makeAddr("seller");
        sellerB = makeAddr("seller-b");
        treasury = makeAddr("treasury");
        sponsor = makeAddr("sponsor");

        usdc = new MockUSDC();
        pool = new EscrowPool(address(usdc), treasury, address(0));

        usdc.mint(buyer, 1_000_000_000);
        usdc.mint(sponsor, 1_000_000_000);

        vm.startPrank(buyer);
        usdc.approve(address(pool), type(uint256).max);
        pool.deposit(INITIAL_DEPOSIT);
        vm.stopPrank();
    }

    function testClaimSucceedsDuringPendingWithdrawWindow() public {
        (EscrowPool.Authorization memory auth, bytes memory sig) = _signLegacyAuthorization(seller, 1, 30_000_000);

        vm.prank(buyer);
        pool.requestWithdraw(INITIAL_DEPOSIT);

        _claim(auth, sig, seller);

        assertEq(pool.getClaimableBalance(buyer), INITIAL_DEPOSIT - auth.amount);
        assertEq(pool.getWithdrawableBalance(buyer), 0);
        assertEq(usdc.balanceOf(seller), _netPayout(auth.amount));

        (uint256 pendingAmount, uint256 unlockAt) = pool.pendingWithdrawals(buyer);
        assertEq(pendingAmount, INITIAL_DEPOSIT);
        assertGt(unlockAt, block.timestamp);
    }

    function testCompleteWithdrawTakesMinOfRequestedAndBalance() public {
        (EscrowPool.Authorization memory auth, bytes memory sig) = _signLegacyAuthorization(seller, 1, 30_000_000);

        vm.prank(buyer);
        pool.requestWithdraw(INITIAL_DEPOSIT);

        _claim(auth, sig, seller);

        vm.warp(block.timestamp + 48 hours + 1);
        vm.prank(buyer);
        pool.completeWithdraw();

        assertEq(usdc.balanceOf(buyer), 1_000_000_000 - auth.amount);
        assertEq(pool.getBalance(buyer), 0);
        (uint256 pendingAmount, uint256 unlockAt) = pool.pendingWithdrawals(buyer);
        assertEq(pendingAmount, 0);
        assertEq(unlockAt, 0);
    }

    function testGetClaimableVsGetWithdrawableSemantics() public {
        vm.prank(buyer);
        pool.requestWithdraw(40_000_000);

        assertEq(pool.getClaimableBalance(buyer), INITIAL_DEPOSIT);
        assertEq(pool.getWithdrawableBalance(buyer), INITIAL_DEPOSIT - 40_000_000);
        assertEq(pool.getAvailableBalance(buyer), INITIAL_DEPOSIT - 40_000_000);
    }

    function testMultipleSellersCanClaimDuringPendingWithdraw() public {
        (EscrowPool.Authorization memory authA, bytes memory sigA) = _signLegacyAuthorization(seller, 1, 10_000_000);
        (EscrowPool.Authorization memory authB, bytes memory sigB) = _signLegacyAuthorization(sellerB, 1, 20_000_000);

        vm.prank(buyer);
        pool.requestWithdraw(INITIAL_DEPOSIT);

        _claim(authA, sigA, seller);
        _claim(authB, sigB, sellerB);

        assertEq(pool.getClaimableBalance(buyer), INITIAL_DEPOSIT - authA.amount - authB.amount);
        assertEq(usdc.balanceOf(seller), _netPayout(authA.amount));
        assertEq(usdc.balanceOf(sellerB), _netPayout(authB.amount));
    }

    function testRequestWithdrawCannotExceedWithdrawableBalance() public {
        vm.prank(buyer);
        pool.requestWithdraw(100_000_000);

        vm.prank(buyer);
        vm.expectRevert(EscrowPool.PendingWithdrawExists.selector);
        pool.requestWithdraw(1);

        vm.prank(buyer);
        pool.cancelWithdraw();

        vm.prank(buyer);
        vm.expectRevert(EscrowPool.InsufficientAvailableBalance.selector);
        pool.requestWithdraw(INITIAL_DEPOSIT + 1);
    }

    function testCancelWithdrawAllowsImmediateNewRequest() public {
        vm.prank(buyer);
        uint256 firstUnlockAt = pool.requestWithdraw(50_000_000);

        vm.prank(buyer);
        pool.cancelWithdraw();

        vm.warp(block.timestamp + 1);
        vm.prank(buyer);
        uint256 secondUnlockAt = pool.requestWithdraw(50_000_000);

        assertEq(secondUnlockAt, block.timestamp + 48 hours);
        assertGt(secondUnlockAt, firstUnlockAt);
    }

    function testClaimAccruesProtocolFeesAndSellerPayout() public {
        (EscrowPool.Authorization memory auth, bytes memory sig) = _signLegacyAuthorization(seller, 1, CLAIM_AMOUNT);

        _claim(auth, sig, seller);

        uint256 fee = (CLAIM_AMOUNT * pool.protocolFeeBps()) / 10_000;
        assertEq(pool.accruedProtocolFees(), fee);
        assertEq(usdc.balanceOf(seller), CLAIM_AMOUNT - fee);
        assertEq(usdc.balanceOf(treasury), 0);
    }

    function testWithdrawProtocolFeesByOwner() public {
        (EscrowPool.Authorization memory auth, bytes memory sig) = _signLegacyAuthorization(seller, 1, CLAIM_AMOUNT);
        _claim(auth, sig, seller);

        uint256 fees = pool.accruedProtocolFees();
        pool.withdrawAllProtocolFees();

        assertEq(pool.accruedProtocolFees(), 0);
        assertEq(usdc.balanceOf(treasury), fees);
    }

    function testClaimSucceedsWhenTreasuryWouldRejectTransfers() public {
        usdc.setBlockedRecipient(treasury, true);
        (EscrowPool.Authorization memory auth, bytes memory sig) = _signLegacyAuthorization(seller, 1, CLAIM_AMOUNT);

        _claim(auth, sig, seller);

        assertGt(pool.accruedProtocolFees(), 0);
        assertEq(usdc.balanceOf(treasury), 0);
        assertEq(usdc.balanceOf(seller), _netPayout(auth.amount));
    }

    function testClaimSucceedsWithGasGriefingMiningRewards() public {
        BurnAllGasMiningRewards griefingRewards = new BurnAllGasMiningRewards();
        pool.setMiningRewards(address(griefingRewards));

        (EscrowPool.Authorization memory auth, bytes memory sig) = _signLegacyAuthorization(seller, 1, CLAIM_AMOUNT);

        _claim(auth, sig, seller);

        assertEq(usdc.balanceOf(seller), _netPayout(auth.amount));
        assertEq(pool.getBalance(buyer), INITIAL_DEPOSIT - auth.amount);
    }

    function testBitmapNoncesCanClaimOutOfOrderAndRejectReplay() public {
        (EscrowPool.Authorization memory auth3, bytes memory sig3) = _signBitmapAuthorization(seller, 3, CLAIM_AMOUNT);
        (EscrowPool.Authorization memory auth1, bytes memory sig1) = _signBitmapAuthorization(seller, 1, CLAIM_AMOUNT);
        (EscrowPool.Authorization memory auth2, bytes memory sig2) = _signBitmapAuthorization(seller, 2, CLAIM_AMOUNT);

        _claim(auth3, sig3, seller);
        _claim(auth1, sig1, seller);
        _claim(auth2, sig2, seller);

        assertTrue(pool.isNonceUsed(buyer, seller, 3));
        assertTrue(pool.isNonceUsed(buyer, seller, 1));
        assertTrue(pool.isNonceUsed(buyer, seller, 2));
        assertEq(pool.getNonce(buyer, seller), 0, "bitmap claims should not advance sequential nonce");

        uint256 expectedPayout = _netPayout(CLAIM_AMOUNT) * 3;
        assertEq(usdc.balanceOf(seller), expectedPayout);

        _claim(auth3, sig3, seller);
        assertEq(usdc.balanceOf(seller), expectedPayout, "replayed bitmap claim must not pay twice");
    }

    function testLegacySequentialAuthorizationsStillSettle() public {
        (EscrowPool.Authorization memory auth1, bytes memory sig1) = _signLegacyAuthorization(seller, 1, CLAIM_AMOUNT);
        (EscrowPool.Authorization memory auth2, bytes memory sig2) = _signLegacyAuthorization(seller, 2, CLAIM_AMOUNT);

        _claim(auth1, sig1, seller);
        _claim(auth2, sig2, seller);

        assertEq(pool.getNonce(buyer, seller), 2);
        assertEq(usdc.balanceOf(seller), _netPayout(CLAIM_AMOUNT) * 2);
    }

    function testDepositForCreditsBuyerWithSponsorFunds() public {
        uint256 beforeBuyerBalance = pool.getBalance(buyer);

        vm.startPrank(sponsor);
        usdc.approve(address(pool), 123_456);
        pool.depositFor(buyer, 123_456);
        vm.stopPrank();

        assertEq(pool.getBalance(buyer), beforeBuyerBalance + 123_456);
        assertEq(usdc.balanceOf(sponsor), 1_000_000_000 - 123_456);
    }

    function testDepositWithPermitRelaysBuyerDepositWithoutGasFromBuyer() public {
        uint256 amount = 234_567;
        uint256 deadline = block.timestamp + 1 hours;

        vm.prank(buyer);
        usdc.approve(address(pool), 0);

        (uint8 v, bytes32 r, bytes32 s) = _signPermit(amount, deadline);
        uint256 beforeBuyerBalance = pool.getBalance(buyer);

        address relayer = makeAddr("relayer");
        vm.prank(relayer);
        pool.depositWithPermit(buyer, amount, deadline, v, r, s);

        assertEq(pool.getBalance(buyer), beforeBuyerBalance + amount);
        assertEq(usdc.balanceOf(buyer), 1_000_000_000 - INITIAL_DEPOSIT - amount);
        assertEq(usdc.allowance(buyer, address(pool)), 0);
    }

    function _claim(EscrowPool.Authorization memory auth, bytes memory sig, address claimer) internal {
        EscrowPool.Authorization[] memory auths = new EscrowPool.Authorization[](1);
        auths[0] = auth;
        bytes[] memory sigs = new bytes[](1);
        sigs[0] = sig;

        vm.prank(claimer);
        pool.claim(auths, sigs);
    }

    function _signLegacyAuthorization(address authSeller, uint256 nonce, uint256 amount)
        internal
        view
        returns (EscrowPool.Authorization memory auth, bytes memory sig)
    {
        auth = EscrowPool.Authorization({
            buyer: buyer,
            seller: authSeller,
            amount: amount,
            nonce: nonce,
            expiresAt: block.timestamp + 1 hours,
            poolId: pool.POOL_ID(),
            nonceMode: uint8(EscrowPool.NonceMode.Sequential)
        });

        bytes32 structHash = keccak256(
            abi.encode(
                LEGACY_AUTHORIZATION_TYPEHASH,
                auth.buyer,
                auth.seller,
                auth.amount,
                auth.nonce,
                auth.expiresAt,
                auth.poolId
            )
        );
        sig = _signDigest(structHash);
    }

    function _signBitmapAuthorization(address authSeller, uint256 nonce, uint256 amount)
        internal
        view
        returns (EscrowPool.Authorization memory auth, bytes memory sig)
    {
        auth = EscrowPool.Authorization({
            buyer: buyer,
            seller: authSeller,
            amount: amount,
            nonce: nonce,
            expiresAt: block.timestamp + 1 hours,
            poolId: pool.POOL_ID(),
            nonceMode: uint8(EscrowPool.NonceMode.Bitmap)
        });

        bytes32 structHash = keccak256(
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
        sig = _signDigest(structHash);
    }

    function _signDigest(bytes32 structHash) internal view returns (bytes memory) {
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", _domainSeparator(), structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(BUYER_PK, digest);
        return abi.encodePacked(r, s, v);
    }

    function _signPermit(uint256 amount, uint256 deadline) internal view returns (uint8 v, bytes32 r, bytes32 s) {
        bytes32 structHash = keccak256(
            abi.encode(PERMIT_TYPEHASH, buyer, address(pool), amount, usdc.nonces(buyer), deadline)
        );
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", usdc.DOMAIN_SEPARATOR(), structHash));
        return vm.sign(BUYER_PK, digest);
    }

    function _domainSeparator() internal view returns (bytes32) {
        return keccak256(
            abi.encode(
                DOMAIN_TYPEHASH,
                keccak256(bytes("ClawEscrowPool")),
                keccak256(bytes("1")),
                block.chainid,
                address(pool)
            )
        );
    }

    function _netPayout(uint256 amount) internal view returns (uint256) {
        return amount - ((amount * pool.protocolFeeBps()) / 10_000);
    }
}
