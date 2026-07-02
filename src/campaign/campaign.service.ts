import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '../../generated/prisma/client';
import {
  CampaignDeployStatus,
  CampaignStatus,
  MilestoneStatus,
  VaultStatus,
} from '../../generated/prisma/enums';
import { PrismaService } from '../prisma/prisma.service';
import { deriveAssetCode, SECONDS_PER_DAY } from './campaign.util';

/** A proposal's fields needed to materialize its campaign. */
export interface ProposalForCampaign {
  id: string;
  businessName: string;
  requestedAmount: Prisma.Decimal;
  lockPeriodDays: number;
}

/** Fields exposed for public campaign browsing (list + detail). */
const PUBLIC_CAMPAIGN_SELECT = {
  id: true,
  contractAddress: true,
  goalAmount: true,
  raisedAmount: true,
  status: true,
  lockEndAt: true,
  startAt: true,
  endAt: true,
  projectToken: { select: { assetCode: true, contractAddress: true } },
} satisfies Prisma.CampaignSelect;

/**
 * Materializes the off-chain Campaign mirror (campaign + share-token + vault rows)
 * for an approved proposal. The on-chain contracts are deployed later, async, by
 * {@link CampaignDeployService}. Created in `PENDING_DEPLOYMENT` / deploy `PENDING`.
 */
@Injectable()
export class CampaignService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Create the Campaign (+ ProjectToken + CampaignVault) rows for a proposal.
   * Runs inside the approval transaction; the unique `proposalId` makes a second
   * call throw P2002, so approval can't double-create.
   */
  async createForProposal(
    tx: Prisma.TransactionClient,
    proposal: ProposalForCampaign,
  ): Promise<{ id: string }> {
    const lockEndAt = new Date(
      Date.now() + proposal.lockPeriodDays * SECONDS_PER_DAY * 1000,
    );
    const campaign = await tx.campaign.create({
      data: {
        proposalId: proposal.id,
        goalAmount: proposal.requestedAmount,
        status: CampaignStatus.PENDING_DEPLOYMENT,
        deployStatus: CampaignDeployStatus.PENDING,
        lockEndAt,
        projectToken: {
          create: {
            assetCode: deriveAssetCode(proposal.businessName, proposal.id),
            isTransferable: false,
          },
        },
        vault: {
          create: { status: VaultStatus.PENDING, lockEndAt },
        },
      },
      select: { id: true },
    });
    // Link the proposal's authored milestones to the campaign and move them out of
    // DRAFT. Their amounts are pinned on-chain by CampaignDeployService (the deploy
    // reads campaign.milestones to build the constructor's Vec<i128>).
    await tx.milestone.updateMany({
      where: { proposalId: proposal.id },
      data: { campaignId: campaign.id, status: MilestoneStatus.PENDING },
    });
    return campaign;
  }

  /** List campaigns whose contracts are live (open for browsing/investment). */
  listActive() {
    return this.prisma.campaign.findMany({
      where: { deployStatus: CampaignDeployStatus.LIVE },
      orderBy: { startAt: 'desc' },
      select: PUBLIC_CAMPAIGN_SELECT,
    });
  }

  /** Public detail for one campaign. */
  async getPublic(id: string) {
    const campaign = await this.prisma.campaign.findUnique({
      where: { id },
      select: PUBLIC_CAMPAIGN_SELECT,
    });
    if (!campaign) {
      throw new NotFoundException('Campaign not found');
    }
    return campaign;
  }
}
