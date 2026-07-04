import { InjectQueue } from '@nestjs/bullmq';
import {
  Injectable,
  Logger,
  NotFoundException,
  OnApplicationBootstrap,
} from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { Queue } from 'bullmq';
import {
  CampaignDeployStatus,
  CampaignStatus,
  UnlockStatus,
} from '../../generated/prisma/enums';
import { PrismaService } from '../prisma/prisma.service';
import { SorobanService } from '../soroban/soroban.service';

export const CAMPAIGN_UNLOCK_QUEUE = 'campaign-unlock';
/** How often to sweep for campaigns whose lock period has elapsed. */
const RECONCILE_INTERVAL_MS = 5 * 60 * 1000;
export interface CampaignUnlockJob {
  campaignId: string;
}

/**
 * Calls the on-chain `unlock()` once a campaign's lock period has elapsed, flipping
 * its `ShareToken` from non-transferable to transferable:
 *
 *   PENDING → UNLOCKING → (unlock() on-chain) → UNLOCKED   (FAILED on error)
 *
 * Unlike the other 5 orchestrators, nothing external ever *tells* this one that
 * work is due — `reconcile()` both discovers and drives due campaigns by comparing
 * `lockEndAt` to wall-clock time (mirrors {@link MilestoneVotingService.settleExpired}).
 * `unlock()` is unconditionally idempotent on-chain (it force-sets the lock flag
 * `false` regardless of its current value), so `drive()` needs no resume-from-tx-hash
 * dance like deploy/release/refund — a lost job or crash just safely re-invokes.
 */
@Injectable()
export class CampaignUnlockService implements OnApplicationBootstrap {
  private readonly logger = new Logger(CampaignUnlockService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly soroban: SorobanService,
    @InjectQueue(CAMPAIGN_UNLOCK_QUEUE) private readonly queue: Queue,
  ) {}

  /** On boot, re-enqueue any campaign whose lock has already elapsed. */
  onApplicationBootstrap(): Promise<void> {
    return this.reconcile();
  }

  /**
   * Periodically sweep for live, non-cancelled campaigns whose `lockEndAt` has
   * passed and are not yet UNLOCKED, and enqueue them. Applies the same date
   * filter on boot as on every tick, so a campaign whose lock hasn't expired yet is
   * never enqueued just because the app restarted. Idempotent: {@link enqueue}
   * dedupes against an in-flight job, and {@link drive} no-ops once UNLOCKED.
   */
  @Interval(RECONCILE_INTERVAL_MS)
  async reconcile(): Promise<void> {
    const due = await this.prisma.campaign.findMany({
      where: {
        unlockStatus: { not: UnlockStatus.UNLOCKED },
        lockEndAt: { lte: new Date() },
        deployStatus: CampaignDeployStatus.LIVE,
        status: { not: CampaignStatus.CANCELLED },
      },
      select: { id: true },
    });
    await Promise.all(due.map((c) => this.enqueue(c.id)));
    if (due.length) {
      this.logger.log(`Re-enqueued ${due.length} due campaign unlock(s)`);
    }
  }

  /**
   * Queue an unlock. `jobId = campaignId` dedupes concurrent adds; we clear any
   * stale (e.g. previously-failed) job first so a re-enqueue always re-attempts.
   */
  async enqueue(campaignId: string): Promise<void> {
    await this.queue.remove(campaignId).catch(() => undefined);
    await this.queue.add('unlock', { campaignId } satisfies CampaignUnlockJob, {
      jobId: campaignId,
    });
  }

  /** Call `unlock()` for a campaign whose lock has elapsed, unless already done. */
  async drive(campaignId: string): Promise<void> {
    const campaign = await this.load(campaignId);
    if (campaign.unlockStatus === UnlockStatus.UNLOCKED) return;

    // A cancelled campaign exits via Merkle refund claim, not P2P transfer —
    // unlocking it serves no purpose and wastes an on-chain tx.
    if (campaign.status === CampaignStatus.CANCELLED) {
      this.logger.warn(`Campaign ${campaignId} unlock skipped: cancelled`);
      return;
    }

    // Race-guard: never unlock early, even if drive() is invoked out-of-band
    // (a stale queued job or a reconcile() bug) ahead of the deadline.
    if (!campaign.lockEndAt || campaign.lockEndAt.getTime() > Date.now()) {
      this.logger.warn(
        `Campaign ${campaignId} unlock skipped: lock not yet expired`,
      );
      return;
    }

    try {
      await this.prisma.campaign.update({
        where: { id: campaignId },
        data: { unlockStatus: UnlockStatus.UNLOCKING },
      });
      const { txHash } = await this.soroban.invokeContract(
        campaign.contractAddress,
        'unlock',
        [],
      );
      await this.prisma.campaign.update({
        where: { id: campaignId },
        data: {
          unlockStatus: UnlockStatus.UNLOCKED,
          unlockTxHash: txHash,
          unlockError: null,
        },
      });
      this.logger.log(`Campaign ${campaignId} UNLOCKED (tx ${txHash})`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await this.prisma.campaign.update({
        where: { id: campaignId },
        data: {
          unlockStatus: UnlockStatus.FAILED,
          unlockError: message,
          unlockAttempts: { increment: 1 },
        },
      });
      this.logger.error(`Campaign ${campaignId} unlock failed: ${message}`);
      throw err; // surface to BullMQ for retry/backoff
    }
  }

  private async load(campaignId: string): Promise<LoadedCampaign> {
    const campaign = await this.prisma.campaign.findUnique({
      where: { id: campaignId },
      select: {
        id: true,
        contractAddress: true,
        status: true,
        unlockStatus: true,
        lockEndAt: true,
      },
    });
    if (!campaign) {
      throw new NotFoundException(`Campaign ${campaignId} not found`);
    }
    if (!campaign.contractAddress) {
      throw new NotFoundException(
        `Campaign ${campaignId}: contract not deployed yet`,
      );
    }
    return { ...campaign, contractAddress: campaign.contractAddress };
  }
}

/** Just the fields {@link CampaignUnlockService.drive} reads. */
interface LoadedCampaign {
  id: string;
  contractAddress: string;
  status: CampaignStatus;
  unlockStatus: UnlockStatus;
  lockEndAt: Date | null;
}
