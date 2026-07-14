import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '../../generated/prisma/client';
import {
  CampaignDeployStatus,
  CampaignStatus,
  MilestoneStatus,
  VaultStatus,
} from '../../generated/prisma/enums';
import { PrismaService } from '../prisma/prisma.service';
import {
  mapMediaToResponse,
  MEDIA_SELECT,
} from '../proposal/proposal-media.util';
import { StorageService } from '../storage/storage.service';
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
  unlockStatus: true,
  unlockTxHash: true,
  startAt: true,
  endAt: true,
  projectToken: { select: { assetCode: true, contractAddress: true } },
  // Human-readable identity lives on the approved proposal (no title/description
  // columns on Campaign). Flattened in toPublicResponse.
  proposal: {
    select: {
      businessName: true,
      businessDescription: true,
    },
  },
  media: {
    select: MEDIA_SELECT,
    orderBy: { sortOrder: 'asc' as const },
  },
} satisfies Prisma.CampaignSelect;

type CampaignWithMedia = Prisma.CampaignGetPayload<{
  select: typeof PUBLIC_CAMPAIGN_SELECT;
}>;

/**
 * Materializes the off-chain Campaign mirror (campaign + share-token + vault rows)
 * for an approved proposal. The on-chain contracts are deployed later, async, by
 * {@link CampaignDeployService}. Created in `PENDING_DEPLOYMENT` / deploy `PENDING`.
 */
@Injectable()
export class CampaignService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
  ) {}

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
    // Same zero-copy link for gallery images + PDF documents.
    await tx.proposalMedia.updateMany({
      where: { proposalId: proposal.id },
      data: { campaignId: campaign.id },
    });
    return campaign;
  }

  /** List campaigns whose contracts are live (open for browsing/investment). */
  async listActive() {
    const rows = await this.prisma.campaign.findMany({
      where: { deployStatus: CampaignDeployStatus.LIVE },
      orderBy: { startAt: 'desc' },
      select: PUBLIC_CAMPAIGN_SELECT,
    });
    return Promise.all(rows.map((r) => this.toPublicResponse(r)));
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
    return this.toPublicResponse(campaign);
  }

  private async toPublicResponse(campaign: CampaignWithMedia) {
    const { media, proposal, ...rest } = campaign;
    return {
      ...rest,
      businessName: proposal.businessName,
      businessDescription: proposal.businessDescription,
      media: await mapMediaToResponse(this.storage, media),
    };
  }
}
