import {
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '../../generated/prisma/client';
import { MilestoneStatus, VoteChoice } from '../../generated/prisma/enums';
import { PrismaService } from '../prisma/prisma.service';
import { StorageService } from '../storage/storage.service';
import { MilestoneReleaseService } from './milestone-release.service';
import { MilestoneVotingService } from './milestone-voting.service';
import type { UploadedFile } from '../kyc/uploaded-file';

const D = (n: string | number) => new Prisma.Decimal(n);

const CONFIG: Record<string, string> = {
  MILESTONE_VOTING_WINDOW_SECONDS: '604800',
  MILESTONE_QUORUM_BPS: '3000',
  MILESTONE_APPROVAL_BPS: '5000',
};

const PROOF: UploadedFile = {
  originalname: 'progress.png',
  mimetype: 'image/png',
  size: 4,
  buffer: Buffer.from('img'),
};

function makeDeps() {
  const prisma = {
    milestone: {
      findFirst: jest.fn(),
      findUnique: jest.fn(),
      findMany: jest.fn().mockResolvedValue([]),
      update: jest.fn().mockResolvedValue({}),
      count: jest.fn().mockResolvedValue(0),
    },
    milestoneVote: {
      findMany: jest.fn().mockResolvedValue([]),
      findUnique: jest.fn().mockResolvedValue(null),
      upsert: jest.fn().mockResolvedValue({}),
    },
    tokenHolding: {
      aggregate: jest.fn(),
      findFirst: jest.fn(),
    },
  };
  const storage = {
    upload: jest.fn().mockResolvedValue('key'),
    getPresignedDownloadUrl: jest.fn().mockResolvedValue('https://signed'),
  };
  const release = { enqueue: jest.fn().mockResolvedValue(undefined) };
  const config = { get: (k: string) => CONFIG[k] } as unknown as ConfigService;
  const service = new MilestoneVotingService(
    prisma as unknown as PrismaService,
    storage as unknown as StorageService,
    release as unknown as MilestoneReleaseService,
    config,
  );
  return { service, prisma, storage, release };
}

const fundedMilestone = (overrides: Record<string, unknown> = {}) => ({
  id: 'm1',
  order: 1,
  campaignId: 'c1',
  status: MilestoneStatus.PENDING,
  campaign: { raisedAmount: D(10000), goalAmount: D(10000) },
  ...overrides,
});

describe('MilestoneVotingService.submitForRelease', () => {
  it('opens voting: uploads the proof, snapshots supply, sets VOTING', async () => {
    const { service, prisma, storage } = makeDeps();
    prisma.milestone.findFirst.mockResolvedValue(fundedMilestone());
    prisma.tokenHolding.aggregate.mockResolvedValue({
      _sum: { balance: D(10000) },
    });

    await service.submitForRelease('owner', 'm1', PROOF);

    expect(storage.upload).toHaveBeenCalled();
    expect(prisma.milestone.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: MilestoneStatus.VOTING,
          snapshotTotalSupply: D(10000),
          votingEndsAt: expect.any(Date) as unknown,
        }) as unknown,
      }),
    );
  });

  it('rejects submission before the campaign is fully funded', async () => {
    const { service, prisma, storage } = makeDeps();
    prisma.milestone.findFirst.mockResolvedValue(
      fundedMilestone({
        campaign: { raisedAmount: D(5000), goalAmount: D(10000) },
      }),
    );

    await expect(
      service.submitForRelease('owner', 'm1', PROOF),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(storage.upload).not.toHaveBeenCalled();
  });

  it('rejects submission when a prior milestone is not yet released', async () => {
    const { service, prisma, storage } = makeDeps();
    prisma.milestone.findFirst.mockResolvedValue(fundedMilestone({ order: 2 }));
    prisma.milestone.count.mockResolvedValue(1); // one lower-order not RELEASED

    await expect(
      service.submitForRelease('owner', 'm1', PROOF),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(storage.upload).not.toHaveBeenCalled();
  });

  it('404s a milestone the caller does not own', async () => {
    const { service, prisma } = makeDeps();
    prisma.milestone.findFirst.mockResolvedValue(null);
    await expect(
      service.submitForRelease('owner', 'm1', PROOF),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('MilestoneVotingService.vote', () => {
  const votingMilestone = {
    campaignId: 'c1',
    status: MilestoneStatus.VOTING,
    votingEndsAt: new Date(Date.now() + 60_000),
  };

  it('records a weighted ballot via upsert', async () => {
    const { service, prisma } = makeDeps();
    prisma.milestone.findUnique.mockResolvedValue(votingMilestone);
    prisma.tokenHolding.findFirst.mockResolvedValue({ balance: D(150) });

    await service.vote('inv', 'm1', VoteChoice.APPROVE);

    expect(prisma.milestoneVote.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          milestoneId: 'm1',
          investorId: 'inv',
          weight: D(150),
          choice: VoteChoice.APPROVE,
        }) as unknown,
      }),
    );
  });

  it('rejects a vote when the window is closed', async () => {
    const { service, prisma } = makeDeps();
    prisma.milestone.findUnique.mockResolvedValue({
      ...votingMilestone,
      votingEndsAt: new Date(Date.now() - 1),
    });
    await expect(
      service.vote('inv', 'm1', VoteChoice.APPROVE),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('forbids voting without shares in the campaign', async () => {
    const { service, prisma } = makeDeps();
    prisma.milestone.findUnique.mockResolvedValue(votingMilestone);
    prisma.tokenHolding.findFirst.mockResolvedValue(null);
    await expect(
      service.vote('inv', 'm1', VoteChoice.APPROVE),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });
});

describe('MilestoneVotingService.settleExpired', () => {
  const expiredVoting = (overrides: Record<string, unknown> = {}) => ({
    id: 'm1',
    status: MilestoneStatus.VOTING,
    votingEndsAt: new Date(Date.now() - 1),
    votingExtended: false,
    snapshotTotalSupply: D(1000),
    ...overrides,
  });

  function arrangeSettle(
    prisma: ReturnType<typeof makeDeps>['prisma'],
    milestone: Record<string, unknown>,
    votes: { weight: Prisma.Decimal; choice: VoteChoice }[],
  ) {
    prisma.milestone.findMany.mockResolvedValue([{ id: 'm1' }]);
    prisma.milestone.findUnique.mockResolvedValue(milestone);
    prisma.milestoneVote.findMany.mockResolvedValue(votes);
  }

  it('approves and enqueues release on quorum + majority', async () => {
    const { service, prisma, release } = makeDeps();
    arrangeSettle(prisma, expiredVoting(), [
      { weight: D(400), choice: VoteChoice.APPROVE },
      { weight: D(100), choice: VoteChoice.REJECT },
    ]);

    await service.settleExpired();

    expect(prisma.milestone.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: MilestoneStatus.APPROVED,
        }) as unknown,
      }),
    );
    expect(release.enqueue).toHaveBeenCalledWith('m1');
  });

  it('rejects on quorum but failed majority', async () => {
    const { service, prisma, release } = makeDeps();
    arrangeSettle(prisma, expiredVoting(), [
      { weight: D(250), choice: VoteChoice.APPROVE },
      { weight: D(300), choice: VoteChoice.REJECT },
    ]);

    await service.settleExpired();

    expect(prisma.milestone.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: MilestoneStatus.REJECTED,
        }) as unknown,
      }),
    );
    expect(release.enqueue).not.toHaveBeenCalled();
  });

  it('extends the window once when quorum is missed', async () => {
    const { service, prisma, release } = makeDeps();
    arrangeSettle(prisma, expiredVoting({ votingExtended: false }), [
      { weight: D(100), choice: VoteChoice.APPROVE },
    ]);

    await service.settleExpired();

    expect(prisma.milestone.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          votingExtended: true,
          votingEndsAt: expect.any(Date) as unknown,
        }) as unknown,
      }),
    );
    expect(release.enqueue).not.toHaveBeenCalled();
  });

  it('default-approves when quorum is still missed after the extension', async () => {
    const { service, prisma, release } = makeDeps();
    arrangeSettle(prisma, expiredVoting({ votingExtended: true }), [
      { weight: D(100), choice: VoteChoice.APPROVE },
    ]);

    await service.settleExpired();

    expect(prisma.milestone.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: MilestoneStatus.APPROVED,
        }) as unknown,
      }),
    );
    expect(release.enqueue).toHaveBeenCalledWith('m1');
  });
});
