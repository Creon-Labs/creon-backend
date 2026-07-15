import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { Queue } from 'bullmq';
import { CampaignStatus } from '../../generated/prisma/enums';
import { fromStroops } from './campaign.util';
import { PrismaService } from '../prisma/prisma.service';
import { SorobanService } from '../soroban/soroban.service';
import { RefundOrchestratorService } from '../refund/refund-orchestrator.service';

export const CAMPAIGN_FUNDING_CLOSE_QUEUE = 'campaign-funding-close';
const RECONCILE_INTERVAL_MS = 5 * 60 * 1000;
const DEADLINE_REFUND_REASON =
  'Funding goal was not reached before the deadline';
export interface CampaignFundingCloseJob {
  campaignId: string;
}

/** Closes a live funding window from the contract's raised amount, never the mirror. */
@Injectable()
export class CampaignFundingCloseService implements OnApplicationBootstrap {
  private readonly logger = new Logger(CampaignFundingCloseService.name);
  constructor(
    private readonly prisma: PrismaService,
    private readonly soroban: SorobanService,
    private readonly refunds: RefundOrchestratorService,
    @InjectQueue(CAMPAIGN_FUNDING_CLOSE_QUEUE) private readonly queue: Queue,
  ) {}
  onApplicationBootstrap(): Promise<void> {
    return this.reconcile();
  }
  @Interval(RECONCILE_INTERVAL_MS)
  async reconcile(): Promise<void> {
    const campaigns = await this.prisma.campaign.findMany({
      where: {
        status: CampaignStatus.ACTIVE,
        endAt: { not: null },
        deployStatus: 'LIVE',
      },
      select: { id: true },
    });
    await Promise.all(campaigns.map(({ id }) => this.enqueue(id)));
  }
  async enqueue(campaignId: string): Promise<void> {
    await this.queue.remove(campaignId).catch(() => undefined);
    await this.queue.add(
      'close',
      { campaignId } satisfies CampaignFundingCloseJob,
      { jobId: campaignId },
    );
  }
  async drive(campaignId: string): Promise<void> {
    const campaign = await this.prisma.campaign.findUnique({
      where: { id: campaignId },
      select: {
        id: true,
        contractAddress: true,
        status: true,
        endAt: true,
        goalAmount: true,
      },
    });
    if (
      !campaign ||
      campaign.status !== CampaignStatus.ACTIVE ||
      !campaign.endAt ||
      !campaign.contractAddress
    )
      return;
    const raised = fromStroops(
      this.soroban.readI128(
        await this.soroban.simulateRead(campaign.contractAddress, 'raised', []),
      ),
    );
    await this.prisma.campaign.update({
      where: { id: campaign.id },
      data: { raisedAmount: raised },
    });
    if (raised.greaterThanOrEqualTo(campaign.goalAmount)) {
      await this.prisma.campaign.updateMany({
        where: { id: campaign.id, status: CampaignStatus.ACTIVE },
        data: { status: CampaignStatus.GOAL_REACHED },
      });
      return;
    }
    if (campaign.endAt.getTime() > Date.now()) return;
    const changed = await this.prisma.$transaction(async (tx) => {
      const result = await tx.campaign.updateMany({
        where: { id: campaign.id, status: CampaignStatus.ACTIVE },
        data: { status: CampaignStatus.CANCELLED, raisedAmount: raised },
      });
      if (result.count === 0) return null;
      return tx.refund.upsert({
        where: { campaignId: campaign.id },
        create: { campaignId: campaign.id, reason: DEADLINE_REFUND_REASON },
        update: {},
        select: { id: true },
      });
    });
    if (changed) {
      await this.refunds.enqueue(changed.id);
      this.logger.log(
        `Campaign ${campaign.id} expired below goal; refund ${changed.id} enqueued`,
      );
    }
  }
}
