import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ProposalStatus } from '../../generated/prisma/enums';
import { PrismaService } from '../prisma/prisma.service';
import { CreateProposalDto } from './dto/create-proposal.dto';
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
} as const;

/**
 * Entrepreneur-facing proposal lifecycle (off-chain only — no Campaign row, no
 * Soroban deploy). A proposal is created as a DRAFT, editable while DRAFT, then
 * submitted (DRAFT → SUBMITTED) to queue it for admin review. Reads are scoped
 * to the calling entrepreneur, so another user's proposal simply 404s.
 */
@Injectable()
export class ProposalService {
  constructor(private readonly prisma: PrismaService) {}

  async create(userId: string, dto: CreateProposalDto) {
    this.assertPositiveAmount(dto.requestedAmount);
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
    return this.prisma.proposal.update({
      where: { id },
      data: dto,
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
}
