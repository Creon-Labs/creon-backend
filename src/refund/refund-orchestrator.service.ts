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
import { RefundStatus } from '../../generated/prisma/enums';
import { fromStroops, toStroops } from '../campaign/campaign.util';
import { buildMerkleTree, leafHash } from '../distribution/merkle.util';
import { PrismaService } from '../prisma/prisma.service';
import { SorobanService } from '../soroban/soroban.service';

export const REFUND_QUEUE = 'refund';
/** How often to sweep for not-yet-COMPLETED refunds and re-enqueue them. */
const RECONCILE_INTERVAL_MS = 5 * 60 * 1000;
export interface RefundJob {
  refundId: string;
}

/**
 * Drives a campaign refund as an idempotent, resumable state machine, mirroring
 * {@link DistributionOrchestratorService}. A refund is structurally a distribution
 * whose per-holder amount is their pro-rata share of the *remaining custody* rather
 * than of a fresh profit deposit:
 *
 *   PENDING → cancel() on-chain (freeze invest + release)
 *           → (snapshot holdings → pro-rata over remaining custody → build Merkle tree
 *              → persist claims)
 *           → set_refund(root) on-chain → COMPLETED   (FAILED on error)
 *
 * Every resume point is derived from **what is already persisted** — `cancelTxHash`
 * set? claims rows exist? `setRefundTxHash` set? — not the status column alone, so a
 * retry after a crash resumes without double-cancelling, rebuilding the tree, or
 * re-posting the root. The refund pot is read on-chain (`raised - released`) so the
 * integer-floor pro-rata leaves sum to ≤ the USDC actually in custody.
 */
@Injectable()
export class RefundOrchestratorService implements OnApplicationBootstrap {
  private readonly logger = new Logger(RefundOrchestratorService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly soroban: SorobanService,
    @InjectQueue(REFUND_QUEUE) private readonly queue: Queue,
  ) {}

  /** On boot, re-enqueue any refund not yet COMPLETED (resume after restart). */
  onApplicationBootstrap(): Promise<void> {
    return this.reconcile();
  }

  /**
   * Periodically re-enqueue any not-yet-COMPLETED refund. Recovers work whose queue
   * job was lost without an app restart (e.g. Valkey restarted). Idempotent:
   * {@link enqueue} dedupes against an in-flight job and {@link drive} no-ops once a
   * refund is COMPLETED.
   */
  @Interval(RECONCILE_INTERVAL_MS)
  async reconcile(): Promise<void> {
    const unfinished = await this.prisma.refund.findMany({
      where: { status: { not: RefundStatus.COMPLETED } },
      select: { id: true },
    });
    await Promise.all(unfinished.map((r) => this.enqueue(r.id)));
    if (unfinished.length) {
      this.logger.log(`Re-enqueued ${unfinished.length} unfinished refund(s)`);
    }
  }

  /**
   * Queue a refund. `jobId = refundId` dedupes concurrent adds; we clear any stale
   * (e.g. previously-failed) job first so a re-enqueue always re-attempts.
   */
  async enqueue(refundId: string): Promise<void> {
    await this.queue.remove(refundId).catch(() => undefined);
    await this.queue.add('refund', { refundId } satisfies RefundJob, {
      jobId: refundId,
    });
  }

  /** Execute the not-yet-done step(s) for a refund through to COMPLETED. */
  async drive(refundId: string): Promise<void> {
    const refund = await this.load(refundId);
    if (refund.status === RefundStatus.COMPLETED) return;

    try {
      await this.ensureCancelledOnChain(refund);
      const root = await this.ensureClaimsBuilt(refund);
      await this.ensureRootPosted(refund, root);
      await this.markCompleted(refundId);
      this.logger.log(`Refund ${refundId} COMPLETED`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await this.prisma.refund.update({
        where: { id: refundId },
        data: {
          status: RefundStatus.FAILED,
          refundError: message,
          refundAttempts: { increment: 1 },
        },
      });
      this.logger.error(`Refund ${refundId} failed: ${message}`);
      throw err; // surface to BullMQ for retry/backoff
    }
  }

  /**
   * Step 1 — freeze the campaign on-chain (`cancel()`, owner-only, platform-signed) so
   * no new `invest()` comes in and no more principal leaves via `release_milestone()`
   * while the refund is being built. `cancel()` is idempotent on-chain, so a retry
   * after a crash between submit and persist just re-cancels harmlessly.
   */
  private async ensureCancelledOnChain(r: LoadedRefund): Promise<void> {
    if (r.cancelTxHash) return;
    const { txHash } = await this.soroban.invokeContract(
      r.campaign.contractAddress,
      'cancel',
      [],
    );
    await this.prisma.refund.update({
      where: { id: r.id },
      data: { cancelTxHash: txHash },
    });
  }

  /**
   * Step 2 — snapshot current registered holders, split the remaining custody
   * (`raised - released`, read on-chain) integer-floor pro-rata by shares, build the
   * Merkle tree, and persist the per-holder claims + root in one transaction.
   * Idempotent: if claims already exist it just returns the stored root. Returns null
   * when there is nothing to refund (no eligible holders or empty custody).
   */
  private async ensureClaimsBuilt(r: LoadedRefund): Promise<Buffer | null> {
    const alreadyBuilt = await this.prisma.refundClaim.count({
      where: { refundId: r.id },
    });
    if (alreadyBuilt > 0) {
      return r.merkleRoot ? Buffer.from(r.merkleRoot, 'hex') : null;
    }

    // During the lock, shares are non-transferable, so every holder is a KYC'd
    // investor (holderId != null). Order by address for deterministic leaf indices.
    const holdings = await this.prisma.tokenHolding.findMany({
      where: {
        campaignId: r.campaignId,
        holderId: { not: null },
        balance: { gt: 0 },
      },
      orderBy: { holderAddress: 'asc' },
      select: { holderId: true, holderAddress: true, balance: true },
    });
    if (holdings.length === 0) {
      this.logger.warn(
        `Refund ${r.id} has no eligible holders; nothing to refund`,
      );
      await this.prisma.refund.update({
        where: { id: r.id },
        data: { totalShares: new Prisma.Decimal(0) },
      });
      return null;
    }

    const balances = holdings.map((h) => toStroops(h.balance));
    const totalSharesStroops = balances.reduce((sum, b) => sum + b, 0n);
    const totalShares = fromStroops(totalSharesStroops);

    // The pot is the principal still in custody, read on-chain so Σ refunds ≤ the
    // USDC actually held even if the off-chain mirror drifted.
    const pool = await this.remainingCustody(r.campaign.contractAddress);
    if (pool <= 0n) {
      this.logger.warn(`Refund ${r.id}: no remaining custody to refund`);
      await this.prisma.refund.update({
        where: { id: r.id },
        data: { totalShares, totalAmount: new Prisma.Decimal(0) },
      });
      return null;
    }

    const snapshotLedger = BigInt(await this.soroban.latestLedger());
    const rows = holdings.map((h, i) => {
      // Integer floor ⇒ Σ amounts ≤ pool (any dust stays in the contract).
      const amountStroops = (pool * balances[i]) / totalSharesStroops;
      return {
        holderId: h.holderId as string,
        shareAmount: h.balance,
        amount: fromStroops(amountStroops),
        leafIndex: i,
        leaf: leafHash(i, h.holderAddress, amountStroops),
      };
    });

    const { root, proofs } = buildMerkleTree(rows.map((row) => row.leaf));

    await this.prisma.$transaction([
      this.prisma.refund.update({
        where: { id: r.id },
        data: {
          totalAmount: fromStroops(pool),
          totalShares,
          snapshotLedger,
          merkleRoot: root.toString('hex'),
        },
      }),
      this.prisma.refundClaim.createMany({
        data: rows.map((row) => ({
          refundId: r.id,
          investorId: row.holderId,
          shareAmount: row.shareAmount,
          amount: row.amount,
          leafIndex: row.leafIndex,
          merkleProof: proofs[row.leafIndex].map((s) => s.toString('hex')),
        })),
      }),
    ]);
    this.logger.log(
      `Refund ${r.id}: built ${rows.length} claim(s), root ${root.toString('hex')}`,
    );
    return root;
  }

  /**
   * Step 3 — post the Merkle root on-chain (`set_refund(root)`, owner-only,
   * platform-signed). Skips when already posted or there is nothing to post. If the
   * contract reports the root already exists — a crash after the on-chain success but
   * before persisting the tx hash — we treat it as posted so the job can complete.
   */
  private async ensureRootPosted(
    r: LoadedRefund,
    root: Buffer | null,
  ): Promise<void> {
    if (r.setRefundTxHash || root === null) return;

    try {
      const { txHash } = await this.soroban.invokeContract(
        r.campaign.contractAddress,
        'set_refund',
        [this.soroban.bytesArg(root)],
      );
      await this.prisma.refund.update({
        where: { id: r.id },
        data: { setRefundTxHash: txHash },
      });
    } catch (err) {
      if (this.isRefundExists(err)) {
        this.logger.warn(
          `Refund ${r.id} root already on-chain; treating as posted`,
        );
        return;
      }
      throw err;
    }
  }

  /** Remaining principal in custody = `raised - released`, read on-chain (read-only). */
  private async remainingCustody(contractAddress: string): Promise<bigint> {
    const [raised, released] = await Promise.all([
      this.soroban.simulateRead(contractAddress, 'raised', []),
      this.soroban.simulateRead(contractAddress, 'released', []),
    ]);
    return this.soroban.readI128(raised) - this.soroban.readI128(released);
  }

  private markCompleted(id: string): Promise<unknown> {
    return this.prisma.refund.update({
      where: { id },
      data: { status: RefundStatus.COMPLETED, refundError: null },
    });
  }

  /** Best-effort match of the contract's `RefundExists` (error #13). */
  private isRefundExists(err: unknown): boolean {
    const msg = err instanceof Error ? err.message : String(err);
    return /Error\(Contract,\s*#13\)/.test(msg) || msg.includes('RefundExists');
  }

  private async load(refundId: string): Promise<LoadedRefund> {
    const r = await this.prisma.refund.findUnique({
      where: { id: refundId },
      select: {
        id: true,
        campaignId: true,
        merkleRoot: true,
        cancelTxHash: true,
        setRefundTxHash: true,
        status: true,
        campaign: { select: { contractAddress: true } },
      },
    });
    if (!r) {
      throw new NotFoundException(`Refund ${refundId} not found`);
    }
    if (!r.campaign.contractAddress) {
      throw new NotFoundException(
        `Refund ${refundId}: campaign has no contract address`,
      );
    }
    return { ...r, campaign: { contractAddress: r.campaign.contractAddress } };
  }
}

/** Just the fields {@link RefundOrchestratorService.drive} reads. */
interface LoadedRefund {
  id: string;
  campaignId: string;
  merkleRoot: string | null;
  cancelTxHash: string | null;
  setRefundTxHash: string | null;
  status: RefundStatus;
  campaign: { contractAddress: string };
}
