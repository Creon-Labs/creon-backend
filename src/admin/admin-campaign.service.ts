import {
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '../../generated/prisma/client';
import {
  CampaignDeployStatus,
  CampaignStatus,
  RefundStatus,
} from '../../generated/prisma/enums';
import { PrismaService } from '../prisma/prisma.service';
import { RefundOrchestratorService } from '../refund/refund-orchestrator.service';

/** Refund summary returned by the cancel endpoint. */
const REFUND_SELECT = {
  id: true,
  campaignId: true,
  reason: true,
  status: true,
  createdAt: true,
} satisfies Prisma.RefundSelect;

/**
 * Admin-side campaign actions. Cancelling a problematic campaign is the **refund
 * trigger** (mirrors {@link AdminProposalService.approve}): it flips the campaign
 * CANCELLED and opens a Refund row in one transaction, then enqueues the async refund
 * orchestrator (which freezes the contract on-chain and builds the pro-rata payout) —
 * never touching the chain inside the HTTP request.
 */
@Injectable()
export class AdminCampaignService {
  private readonly logger = new Logger(AdminCampaignService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly refunds: RefundOrchestratorService,
  ) {}

  /** Cancel a live campaign and open its refund. Idempotent on the (unique) refund. */
  async cancel(campaignId: string, adminId: string, reason: string) {
    // Idempotent: a refund may already be open (re-POST or a prior partial run).
    const existing = await this.prisma.refund.findUnique({
      where: { campaignId },
      select: REFUND_SELECT,
    });
    if (existing) {
      await this.refunds.enqueue(existing.id); // resume if it stalled
      return existing;
    }

    const campaign = await this.assertCancelable(campaignId);

    const refund = await this.prisma.$transaction(async (tx) => {
      await tx.campaign.update({
        where: { id: campaign.id },
        data: { status: CampaignStatus.CANCELLED },
      });
      return tx.refund.create({
        data: { campaignId, reason, status: RefundStatus.PENDING },
        select: REFUND_SELECT,
      });
    });

    await this.refunds.enqueue(refund.id);
    this.logger.log(
      `Campaign ${campaignId} cancelled by ${adminId}; refund ${refund.id} opened`,
    );
    return refund;
  }

  /** A campaign can be cancelled only while live on-chain and not already terminal. */
  private async assertCancelable(campaignId: string) {
    const campaign = await this.prisma.campaign.findUnique({
      where: { id: campaignId },
      select: {
        id: true,
        status: true,
        deployStatus: true,
        contractAddress: true,
      },
    });
    if (!campaign) {
      throw new NotFoundException('Campaign not found');
    }
    if (campaign.status === CampaignStatus.CANCELLED) {
      throw new ConflictException('Campaign is already cancelled');
    }
    if (campaign.status === CampaignStatus.COMPLETED) {
      throw new ConflictException('A completed campaign cannot be cancelled');
    }
    if (
      campaign.deployStatus !== CampaignDeployStatus.LIVE ||
      !campaign.contractAddress
    ) {
      throw new ConflictException('Campaign is not live on-chain');
    }
    return campaign;
  }
}
