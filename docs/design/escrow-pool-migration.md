# Escrow Pool Migration — V1 Channels → V2 EscrowPool

**Status:** Draft, design only (no code yet)
**Author:** Tapeout API Market (TAM) core
**Date:** 2026-04-17
**Target reviewers:** project maintainers

---

## 1. Problem statement

Tapeout API Market V1 inherited a classic state-channel model (`packages/contracts/src/ClawChannel.sol`, lines 50–274). Each (buyer, seller) pair opens its own funded `Channel` struct; buyers sign incremental-amount `Ticket`s; sellers call `settle()` to pull USDC and emit a `MiningRewards.recordSettlement` hook.

This has three pain points in production:

### 1.1 Capital fragmentation (per-pair lockup)

A buyer who wants to route across 8 providers today must either (a) open 8 channels and split their float 8 ways, or (b) re-open channels as they switch providers (each `openChannel` costs ~110k gas + a 1h minimum duration, `MIN_CHANNEL_DURATION = 1 hours`, line 30).

*Example:* A buyer holding $80 USDC who wants `$10` of headroom per provider hits 100% of their capital utilised just to **reach** 8 providers — they cannot burst onto a 9th provider even if only $0.30 has actually been settled against the first 8.

### 1.2 Seller offline lockup

If a seller goes offline with a channel still open and does not cooperate to close, the buyer must:

1. Call `requestClose()` (line 228) — starts `DISPUTE_PERIOD = 1 hour` (line 32; **note**: the problem-statement brief says "7-day challenge period" but the current code uses 1 hour — see §10 Q3).
2. Wait the full period.
3. Call `closeChannel()` (line 245) to recover the unsettled balance.

Even with a 1-hour dispute window, the *whole deposit* is unreachable until closure, and a buyer cannot redeploy it to a different provider during that time.

*Example:* Buyer opens a $20 channel for 24h, seller crashes after $2 of usage. Buyer is stuck with $18 frozen for at least 1h of dispute window, plus gas for `requestClose` + `closeChannel` (~80k gas each).

### 1.3 Surface-area / audit complexity

`ClawChannel.sol` mixes four concerns in one contract: (a) channel lifecycle, (b) seller staking (lines 282–336), (c) slashing, (d) settlement + mining hook. 423 lines total. Multiple state machines interact via shared state (`channels`, `channelNonces`, `sellers`). This is a meaningful audit attack surface for what is fundamentally a **buyer-signs-payment-intent, seller-claims** problem.

### 1.4 UX: deposit-once, pay-anyone

The ideal mental model — and the one users actually expect — is **"deposit $50 once, then let the system pay any provider I use"**. The current model forces the user to think about channels, deposits, and durations per-seller.

---

## 2. Proposed architecture

### 2.1 Core idea

One contract (`EscrowPool.sol`) holds a *single* USDC balance per buyer. Buyers sign per-request EIP-712 `Authorization` messages. Sellers collect authorizations off-chain, then submit a **batch** of them on-chain to pull their earned USDC from the pool.

```
┌──────────┐   deposit()    ┌─────────────────┐
│  Buyer   │ ─────────────▶ │   EscrowPool    │
└──────────┘                │  balances[buyer]│
      │                     └─────────────────┘
      │  sign Authorization        ▲   ▲   ▲
      │  off-chain (per request)   │   │   │ claim(batch)
      ▼                            │   │   │
┌──────────┐      (HTTP/P2P)  ┌────┴──┐┌┴───┴──┐
│Seller A  │◀──────────────── │Seller B││Seller C│
└──────────┘                  └────────┘└────────┘
```

### 2.2 Authorization semantics

Each authorization is a *standalone* non-cumulative claim for a specific request:

```
Authorization { buyer, seller, amount, nonce, expiresAt, poolId, chainId }
```

- `amount` is **per-auth** (not cumulative like V1 tickets — this is a deliberate simplification, see §4.2).
- `nonce` is scoped to the (buyer, seller) pair and strictly increasing *per pair* (see §4.2, §9).
- `expiresAt` bounds replay windows and lets sellers know by when they must claim.
- `poolId` allows the same contract to host multiple logical pools (e.g., per region, per asset) with separate domain separation.

### 2.3 Withdraw flow

1. `requestWithdraw(amount)` — reserves `amount` from `availableBalance`, schedules unlock at `now + WITHDRAW_DELAY`. Default `WITHDRAW_DELAY = 24h` (see §10 Q1).
2. Unlock window elapses → `completeWithdraw()` transfers USDC out.
3. Or `cancelWithdraw()` cancels the request and returns the reserved balance to `availableBalance`.

During the unlock window, **claims against auths signed *before* the withdraw request remain valid** (enforced by `Authorization.expiresAt` checks, see §9 and §4.5).

### 2.4 Settlement batching

Instead of one `settle()` call per ticket (V1), sellers batch N authorizations and submit them in one `claim(auths[], sigs[])` tx. Target cadence: every 1–5 min or every $1 earned, whichever comes first. Expected per-auth gas ≈ 25k–35k after warm storage (vs ~90k for a V1 `settle()` call).

---

## 3. Contract interface sketch (Solidity pseudocode)

```solidity
struct Authorization {
    address buyer;
    address seller;
    uint256 amount;     // per-auth, not cumulative
    uint256 nonce;      // strictly increasing per (buyer, seller)
    uint256 expiresAt;  // unix seconds
    bytes32 poolId;     // domain-separator for multi-pool or region sharding
}

interface IEscrowPool {
    // ---- Buyer deposit / withdraw ----
    function deposit(uint256 amount) external;
    function requestWithdraw(uint256 amount) external returns (uint256 unlockAt);
    function completeWithdraw() external;
    function cancelWithdraw() external;

    // ---- Seller claim ----
    function claim(Authorization[] calldata auths, bytes[] calldata sigs) external;

    // ---- Views ----
    function getAvailableBalance(address buyer) external view returns (uint256);
    function getNonce(address buyer, address seller) external view returns (uint256);

    // ---- Events ----
    event Deposit(address indexed buyer, uint256 amount);
    event Claimed(address indexed buyer, address indexed seller,
                  uint256 amount, uint256 nonce);
    event WithdrawRequested(address indexed buyer, uint256 amount, uint256 unlockAt);
    event WithdrawCompleted(address indexed buyer, uint256 amount);
    event WithdrawCancelled(address indexed buyer, uint256 amount);
}
```

### 3.1 Function-by-function

| Function | Purpose | Preconditions | Failure modes |
|---|---|---|---|
| `deposit(amount)` | Move USDC from caller into their pool balance. | `USDC.allowance(msg.sender, pool) >= amount`. | ERC20 transfer failure, zero amount. |
| `requestWithdraw(amount)` | Start the timelocked exit for `amount`. Reserves it from `availableBalance`; returns `unlockAt = now + WITHDRAW_DELAY`. Overwrites any prior pending request (or revert — see §10 Q4). | `amount <= availableBalance(caller)`. | Insufficient available balance; existing pending request if policy is "no overwrite". |
| `completeWithdraw()` | Finalise the withdrawal after unlock. Transfers USDC out. | `block.timestamp >= request.unlockAt`, pending request exists. | Called too early; no pending request. |
| `cancelWithdraw()` | Abort pending withdrawal; reserved amount returns to `availableBalance`. | Pending request exists. | No pending request. |
| `claim(auths[], sigs[])` | Verify each auth signature, debit buyer, credit seller (minus protocol fee), record nonce, call `MiningRewards.recordSettlement`. | For each auth: `seller == msg.sender`, sig valid, `nonce > nonces[buyer][seller]`, `expiresAt >= now`, `amount <= availableBalance(buyer)`, `poolId == POOL_ID`, `chainId == block.chainid`. | Bad sig, nonce replay, stale auth, insufficient balance (skip-or-revert — see §4), array length mismatch. |
| `getAvailableBalance(buyer)` | `balances[buyer] - pendingWithdrawal[buyer].amount`. | none. | — |
| `getNonce(buyer, seller)` | Last consumed nonce for the pair. | none. | — |

### 3.2 Claim failure semantics (sub-decision)

When one auth in a batch fails validation, two options:

- **(A) Revert whole batch** — simplest, but a single malformed auth poisons all of a seller's earnings for that tx.
- **(B) Skip invalid auths, process valid ones, emit `ClaimSkipped(reason)`** — better seller UX, more gas-complex.

**Recommendation:** (B). The seller composes the batch; they should not be punished for the one stale auth among 50. Gas cost of skip branches is acceptable (~200 gas/skip).

---

## 4. Double-spend defense

This is the single most important section. Unlike V1 channels, an auth signed by a buyer can in principle be presented to *any* seller — the buyer could sign `$8 to A` and `$5 to B` while holding only `$10`. We layer defenses.

### 4.1 Layer 1 — Seller-side balance pre-check

Before serving a request, the seller calls `getAvailableBalance(buyer)` (view, gas 0 to call via RPC) and verifies `available >= requiredAmount`.

**Tradeoffs:**
- Cost: 1 RPC round-trip (~50–150 ms). Cacheable with short TTL (~10s) since balance only decreases via other sellers' claims, which seller can monitor via `Claimed` events.
- Catches: ~99% of honest-but-mistaken double-spends (buyer miscalculates float).
- Doesn't catch: a buyer racing two sellers *simultaneously* where both check the balance before either claims.

**Mitigation for the race:** sellers can additionally simulate the `claim()` call (`eth_call`) immediately before serving — this is the strongest view-only check available.

### 4.2 Layer 2 — First-to-claim wins + nonce ordering

On-chain, ordering is deterministic. Whoever's tx lands first debits the buyer. If buyer signed `$8 to A` and `$5 to B` with `balance=$10`, and A's tx mines first:

- A gets paid $8, `balance = $2`.
- B's claim tx arrives; validation sees `amount=5 > availableBalance=2`. Under policy (B) from §3.2, the auth is **skipped** (emit `ClaimSkipped(InsufficientBalance)`); under (A) the whole batch reverts.

**Nonce space:**

Per-(buyer, seller) nonce space, **strictly increasing per pair**. Reasoning:

- *Cross-seller* ordering has no meaning — a buyer using both A and B should be free to sign `auth(A, nonce=7)` and `auth(B, nonce=3)` independently. Forcing a global nonce per buyer would make the consumer-gateway serialize every outgoing request.
- *Within a pair*, strictly increasing prevents the one attack that matters: a seller replaying an old auth on-chain after a newer one has been submitted.

Alternative: per-pair **bitmap** allowing out-of-order nonces (e.g., for parallel in-flight requests from a single buyer to the same seller). Costs ~20k extra gas per 256-auth window, and adds complexity. **Recommendation: strictly increasing for v1**; revisit if we see real contention inside a single (buyer, seller) pair.

Note the deliberate simplification vs V1: V1 tickets carried a *cumulative* amount so ordering didn't matter beyond "latest wins". V2 auths are *per-request amounts*, which means nonce ordering matters. The benefit is that per-request amounts are trivially composable across sellers (no shared cumulative counter).

### 4.3 Layer 3 — Optional slashing collateral

Idea: buyer deposits `amount + 10%` as bond. Someone who proves a double-spend (submits two valid auths that together exceed the proven balance at some historical block) gets the bond.

**Verdict: defer to v2.** Reasons:
1. Requires historical balance proofs (Merkle proofs against archived state), non-trivial infra.
2. Bond ties up more capital — directly contradicts the "capital efficiency" goal of this migration.
3. Layers 1+2 together already reduce the stiffed-seller loss to at most the *in-flight* amount for that single request (sub-dollar for typical API calls). Adding 10% bond to save sub-dollar losses is bad ROI.

Revisit when median per-request amount crosses $1 or when we see empirical double-spend attempts.

### 4.4 Layer 4 — Reputation / history (out of scope)

Provider-side logic: track double-spend events by buyer, fall back to "prepaid-only" mode for repeat offenders. Lives in `provider-gateway/src/billing.ts` or a future `reputation-oracle` service. Mentioned here for completeness, not designed in this doc.

### 4.5 Adversarial walkthrough

**Setup:** Buyer deposits $10. Signs `authA = (seller=A, amount=$8, nonce=1)` and `authB = (seller=B, amount=$5, nonce=1)`, sends both off-chain.

**Timeline:**
1. Seller A calls `getAvailableBalance(buyer)` → returns `$10`. Pre-check passes. A serves the request.
2. Seller B calls `getAvailableBalance(buyer)` → returns `$10` (A has not claimed yet). Pre-check passes. B serves the request.
3. A submits `claim([authA], [sigA])`. Mines at block N. `balances[buyer] = $2`. A receives $8 (minus protocol fee).
4. B submits `claim([authB], [sigB])`. Mines at block N+k. Validation: `amount=5 > availableBalance=2`. Under policy (B) auth is **skipped** with `ClaimSkipped(InsufficientBalance)` event. B gets $0 for that auth.

**Worst-case loss for B:** $5 — the request they served for free. In practice requests are sub-cent to low-cent, so real-world loss per double-spend event is ~$0.001–$0.01.

**Defenses that cap this loss:**
- Sellers simulate `claim` via `eth_call` immediately before serving (not just view the balance) — reduces race window from seconds to mempool-lag only.
- Seller-side rate-limiting: don't trust a new buyer for more than $X until they've accumulated a few successful claims.
- Provider-gateway refuses to serve if the next auth's required amount is more than 20% of the buyer's available balance (configurable).

**Who wins the race?** Whoever's tx gets included first in a block. No on-chain bias. Miners/searchers can in principle reorder — this is a known MEV surface but low-value (micropayments). If it ever matters, sellers can use private mempools (Flashbots on mainnet, equivalent on Base).

---

## 5. EIP-712 types

### 5.1 Domain

```
EIP712Domain {
  string  name              = "ClawEscrowPool"
  string  version           = "1"
  uint256 chainId           = <baseSepolia = 84532 / base mainnet = 8453>
  address verifyingContract = <EscrowPool deployment>
}
```

Domain is *rebuilt per deployment*. `poolId` in the message is an additional scope so one contract can host multiple logical pools without domain-separator collision (e.g., separate pools for USDC vs PYUSD, or by region).

### 5.2 Message type

```
Authorization {
  address buyer
  address seller
  uint256 amount
  uint256 nonce
  uint256 expiresAt
  bytes32 poolId
}
```

`chainId` is covered by the domain; no need to duplicate inside the struct.

### 5.3 Diff vs V1 Ticket

V1 (`packages/shared/src/types/index.ts:144-148` + `packages/crypto/src/ticket.ts:35-41`):

```ts
Ticket { channelId: bytes32; amount: uint256; nonce: uint256 }
```

V2:

```ts
Authorization {
  buyer: address; seller: address;
  amount: uint256; nonce: uint256;
  expiresAt: uint256; poolId: bytes32;
}
```

Key changes:
- Remove `channelId` (channels no longer exist).
- Add explicit `buyer` + `seller` — removes any dependency on looking up a channel to identify parties.
- Add `expiresAt` — auths are per-request and short-lived (default TTL: 5 min).
- Add `poolId` — domain scope for multi-pool deployments.
- Semantics: `amount` is now **per-auth** (not cumulative).

---

## 6. Migration plan

Phased rollout; both contracts live concurrently during transition.

### Phase 0 — Prep (1 week)
- Finalise this design doc (current step).
- Resolve §10 open questions with project maintainers.
- Lock EIP-712 struct definitions.

### Phase 1 — Deploy in parallel (1–2 weeks)
1. Deploy `EscrowPool.sol` on Base Sepolia alongside existing `ClawChannel.sol`. **Both stay live.**
2. Deploy a new `MiningRewards` instance (or upgrade the existing — see §10 Q2) with `setAuthorisedCaller(escrowPool)` in addition to the legacy clawChannel.
3. Add `getAvailableBalance` and `Claimed` event indexing to the shared indexer.

### Phase 2 — Gateway dual-mode (2 weeks)
4. Provider Gateway and Consumer Gateway learn to speak both protocols; select by feature flag + provider announcement capability bit.
5. New user onboarding defaults to Pool. Existing V1 channels continue until natural expiry or user-initiated close.

### Phase 3 — Migration helper (1 week)
6. Ship a CLI command `claw migrate` that:
   (a) for each active V1 channel: calls `requestClose` then `closeChannel` after dispute window,
   (b) atomically calls `EscrowPool.deposit(refund)` with the recovered USDC.
   This is just UX sugar; no on-chain atomic migration — avoids writing a migration contract that itself needs auditing.

### Phase 4 — MiningRewards integration cutover (1 week)
7. In `MiningRewards.sol` (currently lines 73–76 enforce `msg.sender == clawChannel`), change to an authorised-caller set `{clawChannel, escrowPool}`. This lets both contracts record settlements during the transition window.
8. After all V1 channels drain, remove `clawChannel` from the authorised set.

### Phase 5 — Deprecate V1 (ongoing)
9. Mark `ClawChannel.openChannel` to revert (soft-kill) once migration is broadly complete — existing channels can still `settle` and `closeChannel`.
10. After ~90 days with no active channels, remove `ClawChannel.sol` from the build.

Risk mitigation: the entire plan is non-destructive. A bug in `EscrowPool` does not put V1 channels at risk and vice versa.

---

## 7. Impact on upstream code

File-level changelist with line estimates. Relative paths from repo root.

| File | Change | Est. lines | Notes |
|---|---|---|---|
| `packages/contracts/src/EscrowPool.sol` | **NEW** | ~350 | Core of this migration. |
| `packages/contracts/src/ClawChannel.sol` | deprecate (add soft-kill after Phase 5) | ~10 | Add `openChannelsDisabled` flag; keep `settle`/`closeChannel` live. |
| `packages/contracts/src/MiningRewards.sol` | add authorised-caller set | ~30 | Replace `address public clawChannel` with `mapping(address => bool) public authorisedCallers` + add/remove functions. Current check at lines 73–76. |
| `packages/contracts/test/*` | new `EscrowPool.t.sol`, retain `ClawChannel.t.sol` | ~400 new | Fuzzing over nonce replay, race, withdraw griefing. |
| `packages/crypto/src/ticket.ts` | rename → `authorization.ts`, update types + domain | ~40 | New `AUTHORIZATION_TYPES`, rename `TicketSigner` → `AuthorizationSigner`, domain name `ClawChannel` → `ClawEscrowPool`. Keep old file as re-export shim for 1 release. |
| `packages/crypto/src/index.ts` | re-exports | ~5 | |
| `packages/shared/src/types/index.ts` | add `Authorization`, `SignedAuthorization`, `PoolBalance` types; deprecate `Ticket`, `SignedTicket`, `ChannelState` | ~40 | `Ticket` types remain exported until V1 removal. |
| `packages/consumer-gateway/src/channel-manager.ts` | **rename** to `pool-manager.ts`, rewrite | ~200 (net simpler) | Replace `ensureChannel/openChannel/closeChannel` with `ensureDeposit/requestWithdraw`. Single balance cache instead of per-provider cache. |
| `packages/consumer-gateway/src/index.ts` | wire pool manager | ~20 | |
| `packages/provider-gateway/src/billing.ts` | rewrite verification + add batch queue | ~80 | Replace `verifyTicket` with `verifyAuthorization` (no channel lookup, just sig + on-chain `getNonce` + `getAvailableBalance`). Add `BatchQueue` to accumulate auths and submit `claim` on threshold. |
| `packages/provider-gateway/src/settle-worker.ts` (new) | claim batch submitter | ~120 | Periodically flushes `BatchQueue` to on-chain `claim`. |
| `packages/shared/src/constants.ts` | new constants | ~10 | `WITHDRAW_DELAY_SECONDS`, `AUTH_DEFAULT_TTL_SECONDS`, `CLAIM_BATCH_MAX_SIZE`. |
| CLI (`packages/cli/src/commands/*`) | `migrate`, `deposit`, `withdraw` | ~200 | |
| P2P `InferenceRequest` shape (`packages/shared/src/types/index.ts:67-76`) | replace `channelId/ticketSignature/ticketAmount/ticketNonce` with `authorization` object | ~15 | Bumps protocol version `/clawmarket/inference/1.0.0` → `/clawmarket/inference/2.0.0`. |
| `packages/consumer-gateway/tests/*` | update | ~150 | |
| `packages/provider-gateway/tests/*` | update | ~150 | |
| Integration / e2e tests (`bootstrap/` area) | new "deposit once pay many" scenario | ~100 | |

**Total rough estimate:** ~1800 lines added/changed, ~500 lines eventually removed (V1 channel code, once Phase 5 completes).

---

## 8. Tradeoffs and non-goals

### What this design does NOT solve

- **Instant finality.** Claims still settle on-chain. Batching every 1–5 min means sellers see funds with minutes of delay — same order of magnitude as V1 `settle()`. Users who need sub-second finality must look at a rollup-native or Lightning-style solution.
- **Gas on settlement.** Batching reduces per-auth gas by ~60% (see §2.4) but does not eliminate it. A dedicated rollup with compressed calldata could push this much further.
- **Seller trust.** The seller must still deliver service before claiming. A fraudulent seller can simply take the auth and give garbage output. That's a reputation/arbitration problem, orthogonal to this design.
- **Per-auth individual verification overhead.** Each auth in a batch is verified individually (one `ecrecover` each). Mitigation: **Merkle-batched claims v2** — buyer signs a single root over N auths, seller submits the root + a Merkle proof per claimed auth. Saves sig-verification gas when batch >10. Deferred as v2 of the pool.
- **Capital efficiency under extreme concurrency.** If a buyer wants to run 1000 parallel requests to the same provider, per-pair nonce ordering serializes them. Mitigation (deferred): bitmap nonces (§4.2).

### Comparison table

| System | Deposit model | Settlement | Double-spend defense | Withdraw delay | Best for |
|---|---|---|---|---|---|
| **V1 ClawChannel** | Per (buyer, seller) pair | On-chain `settle` per ticket | Channel-bounded — cumulative amount capped by deposit | 1h dispute | Long-lived seller relationships |
| **V2 EscrowPool** (this doc) | Per buyer, global | On-chain batched `claim` | Balance check + nonce + first-to-claim | 24–48h timelock | Bursty multi-provider routing |
| **Circle Nanopayments** | Custodial, off-chain | Custodian-batched netting | Centralised accounting | Instant (custodial) | Fiat-adjacent, high-throughput, trust Circle |
| **Lightning Network** | Per-pair HTLC channel | Instant off-chain | HTLC + channel cap | ~2 weeks typical | Peer-to-peer BTC payments, high frequency same-pair |
| **Per-seller channels** (generic) | Per pair | On-chain settle | Channel-bounded | Hours to weeks | Strong individual counter-party relationships |

V2 EscrowPool sits between V1 channels and Circle: non-custodial like V1, capital-efficient like Circle.

---

## 9. Security checklist for audit

### Invariants

- **I1 — Solvency.** `USDC.balanceOf(EscrowPool) >= sum(balances) + sum(pendingWithdrawals.amount)`. Must hold after every external call. (Note: strict `==` is broken by anyone `usdc.transfer()`ing to the pool directly — use `>=`.)
- **I2 — No replay.** For each `(buyer, seller)` pair, a claimed nonce `N` cannot be claimed again. Enforced by `nonces[buyer][seller] = N` and the `nonce > nonces[buyer][seller]` check.
- **I3 — Strictly-increasing nonces per pair.** A batch of auths for the same pair must present nonces in increasing order. Implementation: inside `claim`, track a per-pair `localMax` within the batch loop and require each auth's `nonce > localMax`.
   - **Design choice:** strictly increasing (not bitmap). Rationale in §4.2.
- **I4 — Signature non-malleability.** Reject `s > secp256k1n/2` (EIP-2 canonical `s`). Use OpenZeppelin's `ECDSA.tryRecover` which enforces this. Alternatively support EIP-2098 compact signatures.
- **I5 — Reentrancy.** `claim()` transfers USDC to the seller (= `msg.sender`). If USDC is replaced by a token with hooks (hypothetically), reentrancy could drain. Apply `nonReentrant`. Also follow CEI: update `balances` and `nonces` **before** transfer.
- **I6 — Withdraw griefing.** `requestWithdraw` only reserves *idle* balance. Auths signed before a withdraw request can still be claimed out of `balances[buyer]` **as long as the claimed amount does not dip into the reserved portion**. Concretely: `getAvailableBalance = balances - pendingWithdrawal.amount` is the upper bound enforced in `claim`.
   - Subtle case: buyer signs `$8` auth, then requests `$5` withdraw while `balance=$10`. Available = `$5`. Seller's `$8` auth would fail with `InsufficientBalance`. Solution: seller sees this via `getAvailableBalance` and can alert/wait, OR (stricter) we add `claim` priority by letting auths with `signedAt < withdrawRequestedAt` bypass the reservation. The simpler (stricter) version is recommended for v1: buyer is responsible for not over-signing before requesting withdraw.
- **I7 — `expiresAt` enforcement.** `require(auth.expiresAt >= block.timestamp)` — rejects stale auths. Recommended TTL: 5 min.
- **I8 — `poolId` / `chainId` binding.** `require(auth.poolId == POOL_ID)`. Domain separator already binds chainId + contract address; do not also duplicate `chainId` in the struct.
- **I9 — Array length equality.** `require(auths.length == sigs.length)`.
- **I10 — `MiningRewards` callback reentrancy.** `MiningRewards.recordSettlement` now called from `EscrowPool`. Ensure MiningRewards itself has `nonReentrant` (it does, see `MiningRewards.sol:91`). Still, make the call **after** all state updates in `claim`.

### Other audit items

- Unbounded loop DoS in `claim`. Enforce `auths.length <= MAX_BATCH_SIZE` (recommend 100). Gas per claim (~30k) × 100 = 3M gas, well under block limit.
- Front-running withdraw: a seller observing `WithdrawRequested` can try to claim auths before unlock completes — this is *expected and correct* behaviour; the timelock exists precisely to give them that window.
- Signature replay across chains: prevented by chainId in domain separator.
- Signature replay across contract deployments: prevented by `verifyingContract` in domain separator.
- Integer overflow: Solidity 0.8+ checks; amounts bounded by USDC total supply (< 2^64 in practice).
- USDC blacklist: if Circle blacklists the pool contract, funds are frozen. Out of scope — same risk as V1.

---

## 10. Decisions (locked 2026-04-17)

All open product/design questions have been resolved. Implementation must follow these decisions verbatim.

**D1. Withdraw delay: 48h.**
Buyers use the pool as a prepaid balance; a 48h unlock is acceptable friction for the rare exit path, and gives fraud-monitoring more headroom than 24h. `WITHDRAW_DELAY = 48 hours`.

**D2. Slashing collateral: deferred.**
V1 of the Pool ships with Layers 1+2 double-spend defense only (seller balance pre-check + first-to-claim wins). The contract MUST reserve a `slashingBond` mapping field (zero-initialised, no accessor logic) so v2 can enable it without a migration. Do not wire any slashing logic yet.

**D3. Pool topology: single global pool with poolId field.**
Deploy exactly one `EscrowPool` instance on Base mainnet. The `Authorization.poolId` field is still required for EIP-712 domain separation so future multi-pool deployments (per-region, per-asset) don't require redeployment. Reject auths where `poolId != address(this)`.

**D4. Protocol fee: 1% (100 bps).**
Keep parity with V1's `ClawChannel.sol:45`. Fee is deducted at claim time. Revisit after 3 months of mainnet data.

**D5. ClawChannel.sol: delete.**
V2 has no mainnet deployment yet, so there are no existing users to migrate. `ClawChannel.sol` and all references (MiningRewards hook, types, consumer/provider gateway channel code) must be removed as part of this migration. No dual-contract transition period.

**D6. Pending-withdraw overwrite policy: revert.**
If `requestWithdraw` is called while a pending request exists, revert with `PendingWithdrawExists`. Buyer must call `cancelWithdraw` first. This prevents accidental timer resets and keeps state machine trivial.

Prior V1 `DISPUTE_PERIOD = 1 hour` (`ClawChannel.sol:32`) is noted as historical context; the Pool's 48h delay replaces it.

---

## Appendix A — Sequence diagram (happy path)

```
Buyer              ConsumerGW           ProviderGW          Seller          EscrowPool
  |                    |                     |                 |                 |
  |-- deposit $50 ---->|                     |                 |                 |
  |                    |---- deposit(50) -----------------------------------> [tx]
  |                    |<----- balance[buyer] = 50 ----------------------------- |
  |                    |                     |                 |                 |
  |-- "chat, $0.01" -->|                     |                 |                 |
  |                    |--- sign Auth(seller=S, amt=0.01, nonce=1, exp=+5m) ---- |
  |                    |-------- InferenceRequest + auth --->|                 |
  |                    |                     |-- getAvailableBalance(buyer) -->|
  |                    |                     |<------- 50 ---------------------|
  |                    |                     |--- serve API ----->             |
  |                    |<-- response ------- |<-- tokens/text -----|           |
  |                    |                     | queue auth in batch              |
  |                    |                     |        ...N more requests...     |
  |                    |                     |--- claim([auth1..auth50]) --> [tx]
  |                    |                     |<-- USDC payout minus fee ------- |
  |                    |                     |                 |   [MiningRewards.recordSettlement]
```

## Appendix B — Sequence diagram (double-spend race)

```
Buyer signs authA($8→A, nonce=1) and authB($5→B, nonce=1) with balance=$10.

     Seller A                 Seller B                EscrowPool
        |                        |                         |
        |--- getBalance -------->|                         |
        |<-------- $10 -----------------------------------|
        |                        |--- getBalance --------->|
        |                        |<----- $10 -------------|
        | serve                  | serve                   |
        |--- claim([authA]) -----------------------> [tx @ block N]
        |                        |        balance -> $2    |
        |<-- +$8 ------------------------------------------|
        |                        |--- claim([authB]) ---> [tx @ block N+1]
        |                        |   amount=5 > avail=2    |
        |                        |<-- ClaimSkipped(InsufficientBalance) --
                                 |   (B ate the $5 cost)
```
