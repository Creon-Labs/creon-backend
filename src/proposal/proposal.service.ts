import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '../../generated/prisma/client';
import { MilestoneStatus, ProposalStatus } from '../../generated/prisma/enums';
import { toStroops } from '../campaign/campaign.util';
import { PrismaService } from '../prisma/prisma.service';
import {
  CreateMilestoneDto,
  CreateProposalDto,
} from './dto/create-proposal.dto';
import { UpdateProposalDto } from './dto/update-proposal.dto';

/** Fields returned to the entrepreneur for their own proposals. */
const PROPOSAL_SELECT = {
  id: true,
  businessName: true,
  businessDescription: true,
  category: true,
  location: true,
  requestedAmount: true,
  lockPeriodDays: true,
  status: true,
  submittedAt: true,
  createdAt: true,
  updatedAt: true,
  milestones: {
    select: {
      id: true,
      order: true,
      onchainIndex: true,
      title: true,
      description: true,
      amount: true,
      status: true,
      proofKey: true,
      votingStartedAt: true,
      votingEndsAt: true,
      votingExtended: true,
      snapshotTotalSupply: true,
      releaseTxHash: true,
    },
    orderBy: { order: 'asc' },
  },
} satisfies Prisma.ProposalSelect;

/**
 * Entrepreneur-facing proposal lifecycle (off-chain only — no Campaign row, no
 * Soroban deploy). A proposal is created as a DRAFT, editable while DRAFT, then
 * submitted (DRAFT → SUBMITTED) to queue it for admin review. Reads are scoped
 * to the calling entrepreneur, so another user's proposal simply 404s.
 *
 * Milestones are authored here with the proposal (nested create) and are pinned
 * on-chain at approval; their amounts must sum exactly to `requestedAmount`.
 */
@Injectable()
export class ProposalService {
  constructor(private readonly prisma: PrismaService) {}

  async create(userId: string, dto: CreateProposalDto) {
    this.assertPositiveAmount(dto.requestedAmount);
    this.assertMilestonesValid(dto.milestones, dto.requestedAmount);
    return this.prisma.proposal.create({
      data: {
        entrepreneurId: userId,
        businessName: dto.businessName,
        businessDescription: dto.businessDescription,
        category: dto.category,
        location: dto.location,
        requestedAmount: dto.requestedAmount,
        lockPeriodDays: dto.lockPeriodDays,
        status: ProposalStatus.DRAFT,
        milestones: { create: dto.milestones.map(toMilestoneCreate) },
      },
      select: PROPOSAL_SELECT,
    });
  }

  /** The caller's own proposals, newest first. */
  listMine(userId: string) {
    return this.prisma.proposal.findMany({
      where: { entrepreneurId: userId },
      orderBy: { createdAt: 'desc' },
      select: PROPOSAL_SELECT,
    });
  }

  async getMine(userId: string, id: string) {
    const proposal = await this.prisma.proposal.findFirst({
      where: { id, entrepreneurId: userId },
      select: PROPOSAL_SELECT,
    });
    if (!proposal) {
      throw new NotFoundException('Proposal not found');
    }
    return proposal;
  }

  async update(userId: string, id: string, dto: UpdateProposalDto) {
    await this.assertOwnedDraft(userId, id);
    this.assertPositiveAmount(dto.requestedAmount);

    const { milestones, ...rest } = dto;

    // Re-check the sum invariant whenever either side of it changes, using the
    // effective values (fall back to what is already persisted).
    if (milestones !== undefined || rest.requestedAmount !== undefined) {
      const current = await this.prisma.proposal.findUniqueOrThrow({
        where: { id },
        select: {
          requestedAmount: true,
          milestones: {
            select: { order: true, amount: true },
          },
        },
      });
      const effectiveAmount =
        rest.requestedAmount ?? current.requestedAmount.toString();
      const effectiveMilestones =
        milestones ??
        current.milestones.map((m) => ({
          order: m.order,
          amount: m.amount.toString(),
        }));
      this.assertMilestonesValid(effectiveMilestones, effectiveAmount);
    }

    return this.prisma.proposal.update({
      where: { id },
      data: {
        ...rest,
        ...(milestones && {
          // DRAFT has no votes yet, so replacing the whole set is safe.
          milestones: {
            deleteMany: {},
            create: milestones.map(toMilestoneCreate),
          },
        }),
      },
      select: PROPOSAL_SELECT,
    });
  }

  async submit(userId: string, id: string) {
    await this.assertOwnedDraft(userId, id);
    return this.prisma.proposal.update({
      where: { id },
      data: { status: ProposalStatus.SUBMITTED, submittedAt: new Date() },
      select: PROPOSAL_SELECT,
    });
  }

  /** A proposal can only be edited / submitted by its owner while still a DRAFT. */
  private async assertOwnedDraft(userId: string, id: string): Promise<void> {
    const proposal = await this.prisma.proposal.findFirst({
      where: { id, entrepreneurId: userId },
      select: { status: true },
    });
    if (!proposal) {
      throw new NotFoundException('Proposal not found');
    }
    if (proposal.status !== ProposalStatus.DRAFT) {
      throw new ConflictException(
        'Only a draft proposal can be edited or submitted',
      );
    }
  }

  private assertPositiveAmount(amount: string | undefined): void {
    if (amount !== undefined && Number(amount) <= 0) {
      throw new BadRequestException(
        'requestedAmount must be greater than zero',
      );
    }
  }

  /**
   * Milestone orders must be contiguous integers starting at 1, each amount > 0,
   * and the amounts must sum EXACTLY to `requestedAmount` — compared as stroop
   * integers so no floating-point drift can slip past. This mirrors the on-chain
   * constructor check (`sum(milestone_amounts) == goal`).
   */
  private assertMilestonesValid(
    milestones: { order: number; amount: string }[],
    requestedAmount: string,
  ): void {
    const orders = [...milestones.map((m) => m.order)].sort((a, b) => a - b);
    orders.forEach((order, i) => {
      if (order !== i + 1) {
        throw new BadRequestException(
          'milestone orders must be contiguous integers starting at 1',
        );
      }
    });
    for (const m of milestones) {
      if (Number(m.amount) <= 0) {
        throw new BadRequestException(
          'each milestone amount must be greater than zero',
        );
      }
    }
    const sum = milestones.reduce((acc, m) => acc + toStroops(m.amount), 0n);
    if (sum !== toStroops(requestedAmount)) {
      throw new BadRequestException(
        'milestone amounts must sum exactly to requestedAmount',
      );
    }
  }
}

/** Map an authored milestone DTO to a Prisma nested-create row. */
function toMilestoneCreate(m: CreateMilestoneDto) {
  return {
    order: m.order,
    onchainIndex: m.order - 1,
    title: m.title,
    description: m.description,
    amount: m.amount,
    status: MilestoneStatus.DRAFT,
  };
}
