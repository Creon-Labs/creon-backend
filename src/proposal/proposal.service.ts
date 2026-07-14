import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { randomUUID } from 'crypto';
import { Prisma } from '../../generated/prisma/client';
import {
  MilestoneStatus,
  ProposalMediaKind,
  ProposalStatus,
} from '../../generated/prisma/enums';
import { toStroops } from '../campaign/campaign.util';
import type { UploadedFile } from '../kyc/uploaded-file';
import { PrismaService } from '../prisma/prisma.service';
import { StorageService } from '../storage/storage.service';
import {
  CreateMilestoneDto,
  CreateProposalDto,
} from './dto/create-proposal.dto';
import { UpdateProposalDto } from './dto/update-proposal.dto';
import {
  DOCUMENT_MIME_EXT,
  IMAGE_MIME_EXT,
  mapMediaToResponse,
  MAX_DOCUMENTS,
  MAX_IMAGES,
  MEDIA_SELECT,
} from './proposal-media.util';

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
  media: {
    select: MEDIA_SELECT,
    orderBy: { sortOrder: 'asc' as const },
  },
} satisfies Prisma.ProposalSelect;

type ProposalWithMedia = Prisma.ProposalGetPayload<{
  select: typeof PROPOSAL_SELECT;
}>;

/**
 * Entrepreneur-facing proposal lifecycle (off-chain only — no Campaign row, no
 * Soroban deploy). A proposal is created as a DRAFT, editable while DRAFT, then
 * submitted (DRAFT → SUBMITTED) to queue it for admin review. Reads are scoped
 * to the calling entrepreneur, so another user's proposal simply 404s.
 *
 * Milestones are authored here with the proposal (nested create) and are pinned
 * on-chain at approval; their amounts must sum exactly to `requestedAmount`.
 *
 * Media (gallery images + optional PDFs) is managed separately while DRAFT via
 * {@link addMedia} / {@link removeMedia}; on approval the rows are linked to the
 * new Campaign (same pattern as milestones).
 */
@Injectable()
export class ProposalService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
  ) {}

  async create(userId: string, dto: CreateProposalDto) {
    this.assertPositiveAmount(dto.requestedAmount);
    this.assertMilestonesValid(dto.milestones, dto.requestedAmount);
    const proposal = await this.prisma.proposal.create({
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
    return this.toResponse(proposal);
  }

  /** The caller's own proposals, newest first. */
  async listMine(userId: string) {
    const rows = await this.prisma.proposal.findMany({
      where: { entrepreneurId: userId },
      orderBy: { createdAt: 'desc' },
      select: PROPOSAL_SELECT,
    });
    return Promise.all(rows.map((r) => this.toResponse(r)));
  }

  async getMine(userId: string, id: string) {
    const proposal = await this.prisma.proposal.findFirst({
      where: { id, entrepreneurId: userId },
      select: PROPOSAL_SELECT,
    });
    if (!proposal) {
      throw new NotFoundException('Proposal not found');
    }
    return this.toResponse(proposal);
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

    const proposal = await this.prisma.proposal.update({
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
    return this.toResponse(proposal);
  }

  async submit(userId: string, id: string) {
    await this.assertOwnedDraft(userId, id);
    const proposal = await this.prisma.proposal.update({
      where: { id },
      data: { status: ProposalStatus.SUBMITTED, submittedAt: new Date() },
      select: PROPOSAL_SELECT,
    });
    return this.toResponse(proposal);
  }

  /**
   * Upload gallery images and/or PDF documents onto a DRAFT proposal.
   * Caps: {@link MAX_IMAGES} images, {@link MAX_DOCUMENTS} documents per proposal.
   */
  async addMedia(
    userId: string,
    proposalId: string,
    images: UploadedFile[] = [],
    documents: UploadedFile[] = [],
  ) {
    if (images.length === 0 && documents.length === 0) {
      throw new BadRequestException(
        'At least one image or document file is required',
      );
    }
    await this.assertOwnedDraft(userId, proposalId);

    const existing = await this.prisma.proposalMedia.groupBy({
      by: ['kind'],
      where: { proposalId },
      _count: { _all: true },
      _max: { sortOrder: true },
    });
    const imageCount =
      existing.find((e) => e.kind === ProposalMediaKind.IMAGE)?._count._all ??
      0;
    const docCount =
      existing.find((e) => e.kind === ProposalMediaKind.DOCUMENT)?._count
        ._all ?? 0;
    const maxSort =
      existing.reduce((acc, e) => Math.max(acc, e._max.sortOrder ?? -1), -1) ??
      -1;

    if (imageCount + images.length > MAX_IMAGES) {
      throw new BadRequestException(
        `A proposal may have at most ${MAX_IMAGES} images (currently ${imageCount})`,
      );
    }
    if (docCount + documents.length > MAX_DOCUMENTS) {
      throw new BadRequestException(
        `A proposal may have at most ${MAX_DOCUMENTS} documents (currently ${docCount})`,
      );
    }

    let sortOrder = maxSort + 1;
    const creates: Prisma.ProposalMediaCreateManyInput[] = [];

    for (const file of images) {
      const ext = IMAGE_MIME_EXT[file.mimetype];
      if (!ext) {
        throw new BadRequestException('Images must be JPEG, PNG, or WebP');
      }
      const key = `proposals/${proposalId}/images/${randomUUID()}.${ext}`;
      await this.storage.upload(key, file.buffer, file.mimetype);
      creates.push({
        id: randomUUID(),
        proposalId,
        kind: ProposalMediaKind.IMAGE,
        objectKey: key,
        mimeType: file.mimetype,
        originalName: file.originalname,
        sizeBytes: file.size,
        sortOrder: sortOrder++,
      });
    }

    for (const file of documents) {
      const ext = DOCUMENT_MIME_EXT[file.mimetype];
      if (!ext) {
        throw new BadRequestException('Documents must be PDF files');
      }
      const key = `proposals/${proposalId}/documents/${randomUUID()}.${ext}`;
      await this.storage.upload(key, file.buffer, file.mimetype);
      creates.push({
        id: randomUUID(),
        proposalId,
        kind: ProposalMediaKind.DOCUMENT,
        objectKey: key,
        mimeType: file.mimetype,
        originalName: file.originalname,
        sizeBytes: file.size,
        sortOrder: sortOrder++,
      });
    }

    await this.prisma.proposalMedia.createMany({ data: creates });

    const proposal = await this.prisma.proposal.findFirstOrThrow({
      where: { id: proposalId, entrepreneurId: userId },
      select: PROPOSAL_SELECT,
    });
    return this.toResponse(proposal);
  }

  /** Remove one media item from a DRAFT proposal (object store + DB row). */
  async removeMedia(userId: string, proposalId: string, mediaId: string) {
    await this.assertOwnedDraft(userId, proposalId);

    const media = await this.prisma.proposalMedia.findFirst({
      where: { id: mediaId, proposalId },
      select: { id: true, objectKey: true },
    });
    if (!media) {
      throw new NotFoundException('Media not found');
    }

    await this.storage.delete(media.objectKey);
    await this.prisma.proposalMedia.delete({ where: { id: media.id } });

    const proposal = await this.prisma.proposal.findFirstOrThrow({
      where: { id: proposalId, entrepreneurId: userId },
      select: PROPOSAL_SELECT,
    });
    return this.toResponse(proposal);
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

  /** Strip objectKey and attach downloadable URLs for each media row. */
  private async toResponse(proposal: ProposalWithMedia) {
    const { media, ...rest } = proposal;
    return {
      ...rest,
      media: await mapMediaToResponse(this.storage, media),
    };
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
