import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreateProposalDto } from './dto/create-proposal.dto';
import { ProposalService } from './proposal.service';

function makePrisma() {
  return {
    proposal: {
      create: jest.fn(),
      findFirst: jest.fn(),
      findMany: jest.fn(),
      update: jest.fn(),
    },
  } as unknown as PrismaService & {
    proposal: {
      create: jest.Mock;
      findFirst: jest.Mock;
      findMany: jest.Mock;
      update: jest.Mock;
    };
  };
}

const dto: CreateProposalDto = {
  businessName: 'Warung Kopi Nusantara',
  businessDescription: 'Ekspansi gerai kopi UMKM di Yogyakarta.',
  category: 'Kuliner',
  location: 'Yogyakarta',
  requestedAmount: '10000.0000000',
  lockPeriodDays: 180,
};

describe('ProposalService', () => {
  let prisma: ReturnType<typeof makePrisma>;
  let service: ProposalService;

  beforeEach(() => {
    prisma = makePrisma();
    service = new ProposalService(prisma);
  });

  it('creates a proposal as DRAFT owned by the caller', async () => {
    prisma.proposal.create.mockResolvedValue({ id: 'p1', status: 'DRAFT' });

    const result = await service.create('u1', dto);

    expect(prisma.proposal.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          entrepreneurId: 'u1',
          status: 'DRAFT',
          requestedAmount: '10000.0000000',
        }) as unknown,
      }),
    );
    expect(result.status).toBe('DRAFT');
  });

  it('rejects a zero requestedAmount on create (no write)', async () => {
    await expect(
      service.create('u1', { ...dto, requestedAmount: '0' }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.proposal.create).not.toHaveBeenCalled();
  });

  it('404s when getMine finds no proposal for the caller', async () => {
    prisma.proposal.findFirst.mockResolvedValue(null);
    await expect(service.getMine('u1', 'p1')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('updates a DRAFT proposal', async () => {
    prisma.proposal.findFirst.mockResolvedValue({ status: 'DRAFT' });
    prisma.proposal.update.mockResolvedValue({ id: 'p1', status: 'DRAFT' });

    await service.update('u1', 'p1', { businessName: 'Renamed' });

    expect(prisma.proposal.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'p1' },
        data: { businessName: 'Renamed' },
      }),
    );
  });

  it('blocks editing a proposal that is no longer a DRAFT', async () => {
    prisma.proposal.findFirst.mockResolvedValue({ status: 'SUBMITTED' });
    await expect(
      service.update('u1', 'p1', { businessName: 'Renamed' }),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(prisma.proposal.update).not.toHaveBeenCalled();
  });

  it('404s when updating a proposal the caller does not own', async () => {
    prisma.proposal.findFirst.mockResolvedValue(null);
    await expect(
      service.update('u1', 'p1', { businessName: 'Renamed' }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('submits a DRAFT, moving it to SUBMITTED with a submittedAt', async () => {
    prisma.proposal.findFirst.mockResolvedValue({ status: 'DRAFT' });
    prisma.proposal.update.mockResolvedValue({ id: 'p1', status: 'SUBMITTED' });

    const result = await service.submit('u1', 'p1');

    expect(prisma.proposal.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'p1' },
        data: expect.objectContaining({
          status: 'SUBMITTED',
          submittedAt: expect.any(Date) as unknown,
        }) as unknown,
      }),
    );
    expect(result.status).toBe('SUBMITTED');
  });

  it('blocks submitting a proposal that is not a DRAFT', async () => {
    prisma.proposal.findFirst.mockResolvedValue({ status: 'SUBMITTED' });
    await expect(service.submit('u1', 'p1')).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(prisma.proposal.update).not.toHaveBeenCalled();
  });
});
