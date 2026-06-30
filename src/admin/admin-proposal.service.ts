import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ProposalStatus, ReviewDecision } from '../../generated/prisma/enums';
import { CampaignService } from '../campaign/campaign.service';
import { CampaignDeployService } from '../campaign/campaign-deploy.service';
import { PrismaService } from '../prisma/prisma.service';

/** Statuses from which an admin may still act on a proposal. */
const REVIEWABLE: ProposalStatus[] = [
  ProposalStatus.SUBMITTED,
  ProposalStatus.UNDER_REVIEW,
];

/**
 * Admin-side proposal review. Approving a proposal is the **deploy trigger**: it
 * records the decision, materializes the Campaign mirror, then enqueues the async
 * on-chain deploy (never deploying inside the HTTP request).
 */
@Injectable()
export class AdminProposalService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly campaigns: CampaignService,
    private readonly deploy: CampaignDeployService,
  ) {}

  /** List proposals awaiting review; defaults handled by the controller. */
  list(status: ProposalStatus) {
    return this.prisma.proposal.findMany({
      where: { status },
      orderBy: { submittedAt: 'asc' },
      select: {
        id: true,
        businessName: true,
        category: true,
        location: true,
        requestedAmount: true,
        lockPeriodDays: true,
        status: true,
        submittedAt: true,
        entrepreneur: { select: { walletAddress: true, email: true } },
      },
    });
  }

  /**
   * Approve a proposal → write a review, create its Campaign rows (one tx), then
   * enqueue the deploy after commit. Returns the new campaign id.
   */
  async approve(proposalId: string, adminId: string) {
    const proposal = await this.assertReviewable(proposalId);

    const campaign = await this.prisma.$transaction(async (tx) => {
      await tx.proposal.update({
        where: { id: proposalId },
        data: { status: ProposalStatus.APPROVED },
      });
      await tx.proposalReview.create({
        data: { proposalId, adminId, decision: ReviewDecision.APPROVED },
      });
      return this.campaigns.createForProposal(tx, proposal);
    });

    await this.deploy.enqueue(campaign.id);
    return {
      proposalId,
      status: ProposalStatus.APPROVED,
      campaignId: campaign.id,
    };
  }

  /** Reject a proposal with a reason → write a review, set status REJECTED. */
  async reject(proposalId: string, adminId: string, reason: string) {
    await this.assertReviewable(proposalId);

    await this.prisma.$transaction(async (tx) => {
      await tx.proposal.update({
        where: { id: proposalId },
        data: { status: ProposalStatus.REJECTED },
      });
      await tx.proposalReview.create({
        data: {
          proposalId,
          adminId,
          decision: ReviewDecision.REJECTED,
          notes: reason,
        },
      });
    });

    return { proposalId, status: ProposalStatus.REJECTED };
  }

  /** A review action only applies to a SUBMITTED / UNDER_REVIEW proposal. */
  private async assertReviewable(proposalId: string) {
    const proposal = await this.prisma.proposal.findUnique({
      where: { id: proposalId },
      select: {
        id: true,
        businessName: true,
        requestedAmount: true,
        lockPeriodDays: true,
        status: true,
      },
    });
    if (!proposal) {
      throw new NotFoundException('Proposal not found');
    }
    if (!REVIEWABLE.includes(proposal.status)) {
      throw new ConflictException(
        'Only a submitted proposal can be approved or rejected',
      );
    }
    return proposal;
  }
}
