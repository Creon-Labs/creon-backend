import { Injectable } from '@nestjs/common';
import { Prisma } from '../../generated/prisma/client';
import {
  CampaignDeployStatus,
  CampaignStatus,
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
  createForProposal(
    tx: Prisma.TransactionClient,
    proposal: ProposalForCampaign,
  ): Promise<{ id: string }> {
    const lockEndAt = new Date(
      Date.now() + proposal.lockPeriodDays * SECONDS_PER_DAY * 1000,
    );
    return tx.campaign.create({
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
  }
}
