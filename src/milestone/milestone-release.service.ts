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
import { MilestoneStatus } from '../../generated/prisma/enums';
import { PrismaService } from '../prisma/prisma.service';
import { SorobanService } from '../soroban/soroban.service';

export const MILESTONE_RELEASE_QUEUE = 'milestone-release';
/** How often to sweep for approved-but-not-released milestones and re-enqueue them. */
const RECONCILE_INTERVAL_MS = 5 * 60 * 1000;
/** Statuses that still need the orchestrator to run. */
const UNFINISHED: MilestoneStatus[] = [
  MilestoneStatus.APPROVED,
  MilestoneStatus.RELEASING,
];

export interface MilestoneReleaseJob {
  milestoneId: string;
}

/**
 * Drives a milestone's on-chain fund release as an idempotent, resumable state
 * machine, mirroring {@link CampaignDeployService} / {@link DistributionOrchestratorService}:
 *
 *   APPROVED → RELEASING → (release_milestone(index) on-chain) → RELEASED   (FAILED on error)
 *
 * The resume point is derived from **what is already persisted** (`releaseTxHash`
 * set?), not the status column alone, so a crash after the on-chain call but before
 * persisting resumes without double-paying. The contract itself enforces sequential,
 * once-only release (its `next_milestone` counter), so a duplicate invocation reverts
 * with `MilestoneOutOfOrder` — which we treat as "already released" to finalize.
 */
@Injectable()
export class MilestoneReleaseService implements OnApplicationBootstrap {
  private readonly logger = new Logger(MilestoneReleaseService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly soroban: SorobanService,
    @InjectQueue(MILESTONE_RELEASE_QUEUE) private readonly queue: Queue,
  ) {}

  /** On boot, re-enqueue any approved-but-unreleased milestone (resume after restart). */
  onApplicationBootstrap(): Promise<void> {
    return this.reconcile();
  }

  /**
   * Periodically re-enqueue any milestone that is APPROVED/RELEASING but not yet
   * RELEASED. Recovers releases whose queue job was lost (e.g. Valkey restarted) and
   * catches the case where a settled vote failed to enqueue. Idempotent: {@link enqueue}
   * dedupes and {@link drive} no-ops once RELEASED.
   */
  @Interval(RECONCILE_INTERVAL_MS)
  async reconcile(): Promise<void> {
    const unfinished = await this.prisma.milestone.findMany({
      where: { status: { in: UNFINISHED } },
      select: { id: true },
    });
    await Promise.all(unfinished.map((m) => this.enqueue(m.id)));
    if (unfinished.length) {
      this.logger.log(
        `Re-enqueued ${unfinished.length} unfinished milestone release(s)`,
      );
    }
  }

  /**
   * Queue a release. `jobId = milestoneId` dedupes concurrent adds; we clear any stale
   * (e.g. previously-failed) job first so a re-enqueue always re-attempts.
   */
  async enqueue(milestoneId: string): Promise<void> {
    await this.queue.remove(milestoneId).catch(() => undefined);
    await this.queue.add(
      'release',
      { milestoneId } satisfies MilestoneReleaseJob,
      { jobId: milestoneId },
    );
  }

  /** Execute the not-yet-done release step(s) for a milestone through to RELEASED. */
  async drive(milestoneId: string): Promise<void> {
    const milestone = await this.load(milestoneId);
    if (milestone.status === MilestoneStatus.RELEASED) return;

    try {
      await this.ensureReleased(milestone);
      this.logger.log(
        `Milestone ${milestoneId} (index ${milestone.onchainIndex}) RELEASED`,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await this.prisma.milestone.update({
        where: { id: milestoneId },
        data: {
          status: MilestoneStatus.FAILED,
          releaseError: message,
          releaseAttempts: { increment: 1 },
        },
      });
      this.logger.error(`Milestone ${milestoneId} release failed: ${message}`);
      throw err; // surface to BullMQ for retry/backoff
    }
  }

  /**
   * Invoke `release_milestone(index)` on-chain (owner-only, platform-signed) if not
   * already done, then finalize: mark RELEASED and bump the vault's released total in
   * one transaction. If the contract reports `MilestoneOutOfOrder` — a crash after the
   * on-chain success but before persisting the tx hash — treat it as released and
   * finalize (the reconcile loop only re-drives non-RELEASED rows, so it can't double-pay).
   */
  private async ensureReleased(m: LoadedMilestone): Promise<void> {
    if (!m.releaseTxHash) {
      await this.prisma.milestone.update({
        where: { id: m.id },
        data: { status: MilestoneStatus.RELEASING },
      });
      try {
        const { txHash } = await this.soroban.invokeContract(
          m.campaign.contractAddress,
          'release_milestone',
          [this.soroban.u32Arg(m.onchainIndex)],
        );
        await this.prisma.milestone.update({
          where: { id: m.id },
          data: { releaseTxHash: txHash },
        });
      } catch (err) {
        if (!this.isAlreadyReleased(err)) throw err;
        this.logger.warn(
          `Milestone ${m.id} already released on-chain; finalizing`,
        );
      }
    }

    await this.prisma.$transaction([
      this.prisma.milestone.update({
        where: { id: m.id },
        data: { status: MilestoneStatus.RELEASED, releaseError: null },
      }),
      this.prisma.campaignVault.update({
        where: { campaignId: m.campaignId },
        data: { releasedToBusiness: { increment: m.amount } },
      }),
    ]);
  }

  /** Best-effort match of the contract's `MilestoneOutOfOrder` (error #10). */
  private isAlreadyReleased(err: unknown): boolean {
    const msg = err instanceof Error ? err.message : String(err);
    return (
      /Error\(Contract,\s*#10\)/.test(msg) ||
      msg.includes('MilestoneOutOfOrder')
    );
  }

  private async load(milestoneId: string): Promise<LoadedMilestone> {
    const m = await this.prisma.milestone.findUnique({
      where: { id: milestoneId },
      select: {
        id: true,
        campaignId: true,
        onchainIndex: true,
        amount: true,
        status: true,
        releaseTxHash: true,
        campaign: { select: { contractAddress: true } },
      },
    });
    if (!m) {
      throw new NotFoundException(`Milestone ${milestoneId} not found`);
    }
    if (!m.campaignId || !m.campaign?.contractAddress) {
      throw new NotFoundException(
        `Milestone ${milestoneId}: campaign not deployed yet`,
      );
    }
    return {
      id: m.id,
      campaignId: m.campaignId,
      onchainIndex: m.onchainIndex,
      amount: m.amount,
      status: m.status,
      releaseTxHash: m.releaseTxHash,
      campaign: { contractAddress: m.campaign.contractAddress },
    };
  }
}

/** Just the fields {@link MilestoneReleaseService.drive} reads. */
interface LoadedMilestone {
  id: string;
  campaignId: string;
  onchainIndex: number;
  amount: Prisma.Decimal;
  status: MilestoneStatus;
  releaseTxHash: string | null;
  campaign: { contractAddress: string };
}
