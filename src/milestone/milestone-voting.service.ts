import { randomUUID } from 'crypto';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  OnApplicationBootstrap,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Interval } from '@nestjs/schedule';
import { Prisma } from '../../generated/prisma/client';
import {
  CampaignStatus,
  MilestoneStatus,
  VoteChoice,
} from '../../generated/prisma/enums';
import { PrismaService } from '../prisma/prisma.service';
import { StorageService } from '../storage/storage.service';
import { UploadedFile } from '../kyc/uploaded-file';
import { MilestoneReleaseService } from './milestone-release.service';
import { PROOF_MIME_EXT, tallyVotes } from './milestone.util';

/** How often to settle milestones whose voting window has closed. */
const RECONCILE_INTERVAL_MS = 60 * 1000;

/**
 * Off-chain milestone voting (Postgres). The entrepreneur submits a milestone for
 * release (with a proof upload); investors vote weighted by their share balance;
 * quorum is measured against the total supply snapshotted when voting opened. When
 * the window closes a reconcile loop tallies the result — quorum + majority of cast
 * weight approves, a missed quorum extends the window once and then defaults to
 * approved — and enqueues the on-chain release. Voting itself never touches the chain.
 */
@Injectable()
export class MilestoneVotingService implements OnApplicationBootstrap {
  private readonly logger = new Logger(MilestoneVotingService.name);
  private readonly votingWindowSeconds: number;
  private readonly quorumBps: number;
  private readonly approvalBps: number;

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    private readonly release: MilestoneReleaseService,
    config: ConfigService,
  ) {
    this.votingWindowSeconds = Number(
      config.get('MILESTONE_VOTING_WINDOW_SECONDS') ?? 604_800, // 7 days
    );
    this.quorumBps = Number(config.get('MILESTONE_QUORUM_BPS') ?? 3_000); // 30%
    this.approvalBps = Number(config.get('MILESTONE_APPROVAL_BPS') ?? 5_000); // >50%
  }

  /**
   * Entrepreneur submits milestone `milestoneId` for release: verify ownership,
   * full funding, and sequential order; upload the proof; snapshot the total supply;
   * and open the voting window. PENDING → VOTING.
   */
  async submitForRelease(
    userId: string,
    milestoneId: string,
    proof: UploadedFile,
  ) {
    const milestone = await this.prisma.milestone.findFirst({
      where: { id: milestoneId, proposal: { entrepreneurId: userId } },
      select: {
        id: true,
        order: true,
        campaignId: true,
        status: true,
        campaign: {
          select: { raisedAmount: true, goalAmount: true, status: true },
        },
      },
    });
    if (!milestone) {
      throw new NotFoundException('Milestone not found');
    }
    if (!milestone.campaignId || !milestone.campaign) {
      throw new ConflictException('Campaign is not live yet');
    }
    if (milestone.campaign.status === CampaignStatus.CANCELLED) {
      throw new ConflictException('Campaign has been cancelled');
    }
    if (milestone.status !== MilestoneStatus.PENDING) {
      throw new ConflictException(
        'Milestone is not open for submission (already submitted or released)',
      );
    }
    // All-or-nothing: funds only release once the campaign hit its goal.
    if (milestone.campaign.raisedAmount.lt(milestone.campaign.goalAmount)) {
      throw new ConflictException(
        'Campaign has not reached its funding goal yet',
      );
    }
    // Sequential: every lower-order milestone must already be RELEASED.
    const priorUnreleased = await this.prisma.milestone.count({
      where: {
        campaignId: milestone.campaignId,
        order: { lt: milestone.order },
        status: { not: MilestoneStatus.RELEASED },
      },
    });
    if (priorUnreleased > 0) {
      throw new ConflictException(
        'A previous milestone has not been released yet',
      );
    }

    const ext = PROOF_MIME_EXT[proof.mimetype];
    if (!ext) {
      throw new BadRequestException('Proof must be a JPEG, PNG, or PDF file');
    }

    // Snapshot the quorum denominator = total supply (sum of registered holdings).
    // During the lock this equals the raised principal; freeze it so late indexer
    // updates can't move the goalposts mid-vote.
    const supply = await this.prisma.tokenHolding.aggregate({
      where: {
        campaignId: milestone.campaignId,
        holderId: { not: null },
        balance: { gt: 0 },
      },
      _sum: { balance: true },
    });
    const snapshotTotalSupply = supply._sum.balance;
    if (!snapshotTotalSupply || snapshotTotalSupply.lte(0)) {
      throw new ConflictException(
        'Token holdings are not indexed yet; try again shortly',
      );
    }

    const key = `milestones/${milestone.campaignId}/${milestoneId}-${randomUUID()}.${ext}`;
    await this.storage.upload(key, proof.buffer, proof.mimetype);

    const now = new Date();
    const votingEndsAt = new Date(
      now.getTime() + this.votingWindowSeconds * 1000,
    );
    return this.prisma.milestone.update({
      where: { id: milestoneId },
      data: {
        status: MilestoneStatus.VOTING,
        proofKey: key,
        snapshotTotalSupply,
        votingStartedAt: now,
        votingEndsAt,
        votingExtended: false,
      },
      select: MILESTONE_SELECT,
    });
  }

  /**
   * Investor casts (or changes) a ballot on a milestone, weighted by their current
   * share balance. Idempotent per (milestone, investor) via upsert; only while the
   * milestone is VOTING and the window is open.
   */
  async vote(userId: string, milestoneId: string, choice: VoteChoice) {
    const milestone = await this.prisma.milestone.findUnique({
      where: { id: milestoneId },
      select: {
        campaignId: true,
        status: true,
        votingEndsAt: true,
        campaign: { select: { status: true } },
      },
    });
    if (!milestone || !milestone.campaignId) {
      throw new NotFoundException('Milestone not found');
    }
    if (milestone.campaign?.status === CampaignStatus.CANCELLED) {
      throw new ConflictException('Campaign has been cancelled');
    }
    if (
      milestone.status !== MilestoneStatus.VOTING ||
      !milestone.votingEndsAt ||
      milestone.votingEndsAt.getTime() <= Date.now()
    ) {
      throw new ConflictException('Voting is not open for this milestone');
    }

    const holding = await this.prisma.tokenHolding.findFirst({
      where: {
        campaignId: milestone.campaignId,
        holderId: userId,
        balance: { gt: 0 },
      },
      select: { balance: true },
    });
    if (!holding) {
      throw new ForbiddenException('You hold no shares in this campaign');
    }

    await this.prisma.milestoneVote.upsert({
      where: { milestoneId_investorId: { milestoneId, investorId: userId } },
      create: {
        milestoneId,
        investorId: userId,
        weight: holding.balance,
        choice,
      },
      update: { choice, weight: holding.balance, votedAt: new Date() },
    });
    return { milestoneId, choice, weight: holding.balance };
  }

  /** Milestone detail + running tally + the caller's own vote (proof via presigned URL). */
  async getDetail(userId: string, milestoneId: string) {
    const milestone = await this.prisma.milestone.findUnique({
      where: { id: milestoneId },
      select: {
        ...MILESTONE_SELECT,
        proofKey: true,
        snapshotTotalSupply: true,
      },
    });
    if (!milestone) {
      throw new NotFoundException('Milestone not found');
    }
    const [votes, myVote] = await Promise.all([
      this.prisma.milestoneVote.findMany({
        where: { milestoneId },
        select: { weight: true, choice: true },
      }),
      this.prisma.milestoneVote.findUnique({
        where: { milestoneId_investorId: { milestoneId, investorId: userId } },
        select: { choice: true, weight: true, votedAt: true },
      }),
    ]);
    const { proofKey, ...rest } = milestone;
    return {
      ...rest,
      proofUrl: proofKey
        ? await this.storage.getPresignedDownloadUrl(proofKey)
        : null,
      tally: this.tallyView(votes, milestone.snapshotTotalSupply),
      myVote,
    };
  }

  /** All milestones for a campaign, ordered — for the investor voting UI. */
  listForCampaign(campaignId: string) {
    return this.prisma.milestone.findMany({
      where: { campaignId },
      orderBy: { order: 'asc' },
      select: MILESTONE_SELECT,
    });
  }

  /** On boot, settle any milestone whose window closed while the app was down. */
  onApplicationBootstrap(): Promise<void> {
    return this.settleExpired();
  }

  /**
   * Settle every milestone whose voting window has closed: tally quorum + approval,
   * then approve → enqueue release, reject, or extend-once. Runs on an interval so
   * "auto-release when the deadline passes" needs no external trigger.
   */
  @Interval(RECONCILE_INTERVAL_MS)
  async settleExpired(): Promise<void> {
    const now = new Date();
    const expired = await this.prisma.milestone.findMany({
      where: {
        status: MilestoneStatus.VOTING,
        votingEndsAt: { lte: now },
        // Don't approve/enqueue releases for a cancelled campaign.
        campaign: { status: { not: CampaignStatus.CANCELLED } },
      },
      select: { id: true },
    });
    for (const m of expired) {
      await this.settleOne(m.id);
    }
  }

  /** Tally one closed-window milestone and advance its state. */
  private async settleOne(milestoneId: string): Promise<void> {
    const milestone = await this.prisma.milestone.findUnique({
      where: { id: milestoneId },
      select: {
        id: true,
        status: true,
        votingEndsAt: true,
        votingExtended: true,
        snapshotTotalSupply: true,
      },
    });
    // Re-check under fresh read (another tick may have handled it).
    if (
      !milestone ||
      milestone.status !== MilestoneStatus.VOTING ||
      !milestone.votingEndsAt ||
      milestone.votingEndsAt.getTime() > Date.now()
    ) {
      return;
    }

    const votes = await this.prisma.milestoneVote.findMany({
      where: { milestoneId },
      select: { weight: true, choice: true },
    });
    const tally = tallyVotes(
      votes,
      milestone.snapshotTotalSupply,
      this.quorumBps,
      this.approvalBps,
    );

    if (!tally.quorumMet) {
      if (!milestone.votingExtended) {
        // Extend the window once, then (below) default to approved.
        await this.prisma.milestone.update({
          where: { id: milestoneId },
          data: {
            votingExtended: true,
            votingEndsAt: new Date(
              Date.now() + this.votingWindowSeconds * 1000,
            ),
          },
        });
        this.logger.log(
          `Milestone ${milestoneId} quorum missed; window extended once`,
        );
        return;
      }
      // Already extended and still no quorum → default approve so a passive
      // electorate can't starve the business.
      await this.approve(
        milestoneId,
        'quorum missed after extension (default)',
      );
      return;
    }

    if (tally.approvalMet) {
      await this.approve(milestoneId, 'quorum + majority approved');
    } else {
      await this.prisma.milestone.update({
        where: { id: milestoneId },
        data: { status: MilestoneStatus.REJECTED },
      });
      this.logger.log(`Milestone ${milestoneId} REJECTED by vote`);
    }
  }

  /** Flip APPROVED and enqueue the on-chain release (reconcile recovers a failed enqueue). */
  private async approve(milestoneId: string, reason: string): Promise<void> {
    await this.prisma.milestone.update({
      where: { id: milestoneId },
      data: { status: MilestoneStatus.APPROVED },
    });
    await this.release.enqueue(milestoneId);
    this.logger.log(`Milestone ${milestoneId} APPROVED (${reason})`);
  }

  /** Present the tally as human-readable Decimals + the config thresholds. */
  private tallyView(
    votes: { weight: Prisma.Decimal; choice: VoteChoice }[],
    snapshotTotalSupply: Prisma.Decimal | null,
  ) {
    const t = tallyVotes(
      votes,
      snapshotTotalSupply,
      this.quorumBps,
      this.approvalBps,
    );
    return {
      participation: new Prisma.Decimal(t.participationStroops.toString()).div(
        1e7,
      ),
      approve: new Prisma.Decimal(t.approveStroops.toString()).div(1e7),
      reject: new Prisma.Decimal(t.rejectStroops.toString()).div(1e7),
      totalSupply: snapshotTotalSupply,
      quorumMet: t.quorumMet,
      approvalMet: t.approvalMet,
      quorumBps: this.quorumBps,
      approvalBps: this.approvalBps,
    };
  }
}

/** Fields returned for a milestone across the voting surface. */
const MILESTONE_SELECT = {
  id: true,
  campaignId: true,
  order: true,
  onchainIndex: true,
  title: true,
  description: true,
  amount: true,
  status: true,
  votingStartedAt: true,
  votingEndsAt: true,
  votingExtended: true,
  releaseTxHash: true,
} satisfies Prisma.MilestoneSelect;
