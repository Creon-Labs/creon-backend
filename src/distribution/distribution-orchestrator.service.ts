import { InjectQueue } from '@nestjs/bullmq';
import {
  Injectable,
  Logger,
  NotFoundException,
  OnApplicationBootstrap,
} from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { Queue } from 'bullmq';
import { Prisma } from '../../generated/prisma/client';
import { DistributionStatus } from '../../generated/prisma/enums';
import { fromStroops, toStroops } from '../campaign/campaign.util';
import { PrismaService } from '../prisma/prisma.service';
import { SorobanService } from '../soroban/soroban.service';
import { buildMerkleTree, leafHash } from './merkle.util';

export const DISTRIBUTION_QUEUE = 'distribution';
/** How often to sweep for not-yet-COMPLETED distributions and re-enqueue them. */
const RECONCILE_INTERVAL_MS = 5 * 60 * 1000;
export interface DistributionJob {
  distributionId: string;
}

/**
 * Drives a profit distribution as an idempotent, resumable state machine, mirroring
 * {@link CampaignDeployService}:
 *
 *   PENDING → (snapshot holdings → build Merkle tree → persist claims)
 *           → set_distribution(id, root) on-chain → COMPLETED   (FAILED on error)
 *
 * Both resume points are derived from **what is already persisted** — claims rows
 * exist? `setDistributionTxHash` set? — not from the status column alone, so a retry
 * after a crash at any point resumes without rebuilding the tree or double-posting
 * the root. The backend builds a tree whose leaf amounts sum to ≤ the deposited
 * amount (integer-floor pro-rata), so total on-chain claims are bounded by the
 * deposit even though the contract does not itself track a per-distribution cap.
 */
@Injectable()
export class DistributionOrchestratorService implements OnApplicationBootstrap {
  private readonly logger = new Logger(DistributionOrchestratorService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly soroban: SorobanService,
    @InjectQueue(DISTRIBUTION_QUEUE) private readonly queue: Queue,
  ) {}

  /** On boot, re-enqueue any distribution not yet COMPLETED (resume after restart). */
  onApplicationBootstrap(): Promise<void> {
    return this.reconcile();
  }

  /**
   * Periodically re-enqueue any not-yet-COMPLETED distribution. Recovers work whose
   * queue job was lost without an app restart (e.g. Valkey restarted). Idempotent:
   * {@link enqueue} dedupes against an in-flight job and {@link drive} no-ops once a
   * distribution is COMPLETED.
   */
  @Interval(RECONCILE_INTERVAL_MS)
  async reconcile(): Promise<void> {
    const unfinished = await this.prisma.profitDistribution.findMany({
      where: { status: { not: DistributionStatus.COMPLETED } },
      select: { id: true },
    });
    await Promise.all(unfinished.map((d) => this.enqueue(d.id)));
    if (unfinished.length) {
      this.logger.log(
        `Re-enqueued ${unfinished.length} unfinished distribution(s)`,
      );
    }
  }

  /**
   * Queue a distribution. `jobId = distributionId` dedupes concurrent adds; we clear
   * any stale (e.g. previously-failed) job first so a re-enqueue always re-attempts.
   */
  async enqueue(distributionId: string): Promise<void> {
    await this.queue.remove(distributionId).catch(() => undefined);
    await this.queue.add(
      'distribute',
      { distributionId } satisfies DistributionJob,
      { jobId: distributionId },
    );
  }

  /** Execute the not-yet-done step(s) for a distribution through to COMPLETED. */
  async drive(distributionId: string): Promise<void> {
    const distribution = await this.load(distributionId);
    if (distribution.status === DistributionStatus.COMPLETED) return;

    try {
      const root = await this.ensureClaimsBuilt(distribution);
      await this.ensureRootPosted(distribution, root);
      await this.markCompleted(distributionId);
      this.logger.log(`Distribution ${distributionId} COMPLETED`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await this.prisma.profitDistribution.update({
        where: { id: distributionId },
        data: {
          status: DistributionStatus.FAILED,
          distributionError: message,
          distributionAttempts: { increment: 1 },
        },
      });
      this.logger.error(`Distribution ${distributionId} failed: ${message}`);
      throw err; // surface to BullMQ for retry/backoff
    }
  }

  /**
   * Step 1 — snapshot current registered holders, compute integer-floor pro-rata
   * entitlements, build the Merkle tree, and persist the per-holder claims + root in
   * one transaction. Idempotent: if claims already exist it just returns the stored
   * root. Returns null when there are no eligible holders (nothing to post).
   */
  private async ensureClaimsBuilt(
    d: LoadedDistribution,
  ): Promise<Buffer | null> {
    const alreadyBuilt = await this.prisma.distributionClaim.count({
      where: { distributionId: d.id },
    });
    if (alreadyBuilt > 0) {
      return d.merkleRoot ? Buffer.from(d.merkleRoot, 'hex') : null;
    }

    // During the lock, shares are non-transferable, so every holder is a KYC'd
    // investor (holderId != null). Order by address for deterministic leaf indices.
    const holdings = await this.prisma.tokenHolding.findMany({
      where: {
        campaignId: d.campaignId,
        holderId: { not: null },
        balance: { gt: 0 },
      },
      orderBy: { holderAddress: 'asc' },
      select: { holderId: true, holderAddress: true, balance: true },
    });
    if (holdings.length === 0) {
      this.logger.warn(
        `Distribution ${d.id} has no eligible holders; nothing to distribute`,
      );
      await this.prisma.profitDistribution.update({
        where: { id: d.id },
        data: { totalShares: new Prisma.Decimal(0) },
      });
      return null;
    }

    const totalAmountStroops = toStroops(d.totalAmount);
    const balances = holdings.map((h) => toStroops(h.balance));
    const totalSharesStroops = balances.reduce((sum, b) => sum + b, 0n);

    const rows = holdings.map((h, i) => {
      // Integer floor ⇒ Σ amounts ≤ totalAmount (any dust stays in the contract).
      const amountStroops =
        (totalAmountStroops * balances[i]) / totalSharesStroops;
      return {
        holderId: h.holderId as string,
        shareAmount: h.balance,
        amount: fromStroops(amountStroops),
        leafIndex: i,
        leaf: leafHash(i, h.holderAddress, amountStroops),
      };
    });

    const { root, proofs } = buildMerkleTree(rows.map((r) => r.leaf));
    const totalShares = fromStroops(totalSharesStroops);

    await this.prisma.$transaction([
      this.prisma.profitDistribution.update({
        where: { id: d.id },
        data: {
          totalShares,
          rewardPerShare: new Prisma.Decimal(d.totalAmount).div(totalShares),
          merkleRoot: root.toString('hex'),
        },
      }),
      this.prisma.distributionClaim.createMany({
        data: rows.map((r) => ({
          distributionId: d.id,
          investorId: r.holderId,
          shareAmount: r.shareAmount,
          amount: r.amount,
          leafIndex: r.leafIndex,
          merkleProof: proofs[r.leafIndex].map((s) => s.toString('hex')),
        })),
      }),
    ]);
    this.logger.log(
      `Distribution ${d.id}: built ${rows.length} claim(s), root ${root.toString('hex')}`,
    );
    return root;
  }

  /**
   * Step 2 — post the Merkle root on-chain (`set_distribution(id, root)`, owner-only,
   * platform-signed). Skips when already posted or there is nothing to post. If the
   * contract reports the root already exists — a crash after the on-chain success but
   * before persisting the tx hash — we treat it as posted so the job can complete
   * (the reconcile loop only re-drives non-COMPLETED rows, so it is never re-posted).
   */
  private async ensureRootPosted(
    d: LoadedDistribution,
    root: Buffer | null,
  ): Promise<void> {
    if (d.setDistributionTxHash || root === null) return;

    try {
      const { txHash } = await this.soroban.invokeContract(
        d.campaign.contractAddress,
        'set_distribution',
        [this.soroban.u32Arg(d.onchainId), this.soroban.bytesArg(root)],
      );
      await this.prisma.profitDistribution.update({
        where: { id: d.id },
        data: { setDistributionTxHash: txHash },
      });
    } catch (err) {
      if (this.isDistributionExists(err)) {
        this.logger.warn(
          `Distribution ${d.id} root already on-chain; treating as posted`,
        );
        return;
      }
      throw err;
    }
  }

  private markCompleted(id: string): Promise<unknown> {
    return this.prisma.profitDistribution.update({
      where: { id },
      data: { status: DistributionStatus.COMPLETED, distributionError: null },
    });
  }

  /** Best-effort match of the contract's `DistributionExists` (error #3). */
  private isDistributionExists(err: unknown): boolean {
    const msg = err instanceof Error ? err.message : String(err);
    return (
      /Error\(Contract,\s*#3\)/.test(msg) || msg.includes('DistributionExists')
    );
  }

  private async load(distributionId: string): Promise<LoadedDistribution> {
    const d = await this.prisma.profitDistribution.findUnique({
      where: { id: distributionId },
      select: {
        id: true,
        campaignId: true,
        onchainId: true,
        totalAmount: true,
        merkleRoot: true,
        setDistributionTxHash: true,
        status: true,
        campaign: { select: { contractAddress: true } },
      },
    });
    if (!d) {
      throw new NotFoundException(`Distribution ${distributionId} not found`);
    }
    if (!d.campaign.contractAddress) {
      throw new NotFoundException(
        `Distribution ${distributionId}: campaign has no contract address`,
      );
    }
    return { ...d, campaign: { contractAddress: d.campaign.contractAddress } };
  }
}

/** Just the fields {@link DistributionOrchestratorService.drive} reads. */
interface LoadedDistribution {
  id: string;
  campaignId: string;
  onchainId: number;
  totalAmount: Prisma.Decimal;
  merkleRoot: string | null;
  setDistributionTxHash: string | null;
  status: DistributionStatus;
  campaign: { contractAddress: string };
}
