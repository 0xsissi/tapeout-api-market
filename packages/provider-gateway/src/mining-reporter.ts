/**
 * MiningReporter — Report settlements for CLAW token mining rewards
 * New module for V2 token economics.
 *
 * After claiming an EscrowPool batch, the provider can report the settlement
 * to the MiningRewards contract to earn CLAW tokens proportional to the
 * settled USDC amount and quality attestation.
 */

import { ethers } from 'ethers';
import type { QualityAttestation } from '@clawmarket/shared';

/** MiningRewards contract ABI — relevant functions only */
const MINING_ABI = [
  'function reportSettlement(bytes32 settlementRef, uint256 settledAmount, uint256 qualityMultiplier, bytes buyerAttestation) external',
  'function pendingRewards(address provider) view returns (uint256)',
  'function claimRewards() external',
  'function currentPhase() view returns (uint256)',
  'event RewardAccrued(address indexed provider, uint256 settledUsdc, uint256 tokenReward, uint256 qualityMultiplier, uint256 phase)',
];

export class MiningReporter {
  private readonly provider: ethers.JsonRpcProvider;
  private readonly wallet: ethers.Wallet;
  private readonly contract: ethers.Contract;

  /**
   * @param privateKey       - Provider wallet private key
   * @param miningContract   - MiningRewards contract address
   * @param rpcUrl           - JSON-RPC endpoint
   */
  constructor(
    privateKey: `0x${string}`,
    miningContract: `0x${string}`,
    rpcUrl: string
  ) {
    this.provider = new ethers.JsonRpcProvider(rpcUrl);
    this.wallet = new ethers.Wallet(privateKey, this.provider);
    this.contract = new ethers.Contract(miningContract, MINING_ABI, this.wallet);
  }

  /**
   * Report a settlement to the MiningRewards contract to earn CLAW tokens.
   *
   * @param settlementRef      - A bytes32 reference for the settled claim batch
   * @param amount             - Settled USDC amount in micro-USDC (6 decimals)
   * @param qualityAttestation - Optional quality attestation from the buyer
   * @returns Transaction hash, or null on failure
   */
  async reportSettlement(
    settlementRef: `0x${string}`,
    amount: bigint,
    qualityAttestation?: QualityAttestation
  ): Promise<string | null> {
    const qualityMultiplier = qualityAttestation
      ? this._deriveMultiplier(qualityAttestation)
      : 100; // 1.0x default (stored as integer, 100 = 1.0)

    // Encode buyer attestation if provided, otherwise empty bytes
    const attestationBytes = qualityAttestation
      ? ethers.AbiCoder.defaultAbiCoder().encode(
          ['string', 'uint256', 'uint256', 'uint256', 'bool', 'bytes'],
          [
            qualityAttestation.requestId,
            qualityAttestation.ttftMs,
            qualityAttestation.totalLatencyMs,
            qualityAttestation.tokensPerSecond,
            qualityAttestation.success,
            qualityAttestation.buyerSignature,
          ]
        )
      : '0x';

    try {
      const tx = await this.contract.reportSettlement(
        settlementRef,
        amount,
        qualityMultiplier,
        attestationBytes
      );
      console.log(`[Mining] Settlement reported: ${settlementRef.slice(0, 10)}... TX: ${tx.hash}`);
      const receipt = await tx.wait();
      console.log(`[Mining] Confirmed in block ${receipt.blockNumber}`);
      return tx.hash as string;
    } catch (err: unknown) {
      const reason = (err as { reason?: string }).reason;
      const message = reason || (err instanceof Error ? err.message : String(err));
      console.error(`[Mining] Report failed: ${message}`);
      return null;
    }
  }

  /**
   * Query pending (unclaimed) CLAW token rewards for this provider.
   * @returns Pending reward amount in CLAW token wei
   */
  async getAccumulatedRewards(): Promise<bigint> {
    try {
      const pending: bigint = await this.contract.pendingRewards(this.wallet.address);
      return pending;
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[Mining] Failed to query rewards: ${message}`);
      return 0n;
    }
  }

  /**
   * Claim all accumulated CLAW token mining rewards.
   * @returns Transaction hash, or null on failure
   */
  async claimRewards(): Promise<string | null> {
    try {
      const pending = await this.getAccumulatedRewards();
      if (pending === 0n) {
        console.log('[Mining] No pending rewards to claim');
        return null;
      }

      const tx = await this.contract.claimRewards();
      console.log(`[Mining] Claiming ${ethers.formatEther(pending)} CLAW... TX: ${tx.hash}`);
      const receipt = await tx.wait();
      console.log(`[Mining] Claimed in block ${receipt.blockNumber}`);
      return tx.hash as string;
    } catch (err: unknown) {
      const reason = (err as { reason?: string }).reason;
      const message = reason || (err instanceof Error ? err.message : String(err));
      console.error(`[Mining] Claim failed: ${message}`);
      return null;
    }
  }

  /**
   * Query the current mining phase from the contract.
   */
  async getCurrentPhase(): Promise<number> {
    try {
      const phase = await this.contract.currentPhase();
      return Number(phase);
    } catch {
      return 0;
    }
  }

  /**
   * Derive quality multiplier from a buyer attestation.
   * Based on QUALITY_MULTIPLIERS constants from @clawmarket/shared.
   */
  private _deriveMultiplier(attestation: QualityAttestation): number {
    if (!attestation.success) return 50; // POOR

    const ttft = attestation.ttftMs;
    if (ttft < 300) return 150;  // EXCELLENT
    if (ttft < 500) return 120;  // GOOD
    if (ttft < 1000) return 100; // NORMAL
    return 50;                    // POOR
  }
}
