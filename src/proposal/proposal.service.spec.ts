import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { ProposalMediaKind } from '../../generated/prisma/enums';
import type { UploadedFile } from '../kyc/uploaded-file';
import { PrismaService } from '../prisma/prisma.service';
import { StorageService } from '../storage/storage.service';
import { CreateProposalDto } from './dto/create-proposal.dto';
import { ProposalService } from './proposal.service';

function makePrisma() {
  return {
    proposal: {
      create: jest.fn(),
      findFirst: jest.fn(),
      findFirstOrThrow: jest.fn(),
      findMany: jest.fn(),
      findUniqueOrThrow: jest.fn(),
      update: jest.fn(),
    },
    proposalMedia: {
      groupBy: jest.fn().mockResolvedValue([]),
      createMany: jest.fn().mockResolvedValue({ count: 0 }),
      findFirst: jest.fn(),
      delete: jest.fn().mockResolvedValue({}),
    },
  } as unknown as PrismaService & {
    proposal: {
      create: jest.Mock;
      findFirst: jest.Mock;
      findFirstOrThrow: jest.Mock;
      findMany: jest.Mock;
      findUniqueOrThrow: jest.Mock;
      update: jest.Mock;
    };
    proposalMedia: {
      groupBy: jest.Mock;
      createMany: jest.Mock;
      findFirst: jest.Mock;
      delete: jest.Mock;
    };
  };
}

function makeStorage() {
  return {
    upload: jest.fn().mockResolvedValue('key'),
    delete: jest.fn().mockResolvedValue(undefined),
    getPublicUrl: jest.fn((key: string) => `https://cdn.example/${key}`),
    getPresignedDownloadUrl: jest
      .fn()
      .mockResolvedValue('https://signed.example/file'),
  } as unknown as StorageService & {
    upload: jest.Mock;
    delete: jest.Mock;
    getPublicUrl: jest.Mock;
    getPresignedDownloadUrl: jest.Mock;
  };
}

function fakeFile(
  partial: Partial<UploadedFile> & Pick<UploadedFile, 'mimetype'>,
): UploadedFile {
  return {
    originalname: partial.originalname ?? 'file.bin',
    mimetype: partial.mimetype,
    size: partial.size ?? 100,
    buffer: partial.buffer ?? Buffer.from('x'),
  };
}

const dto: CreateProposalDto = {
  businessName: 'Warung Kopi Nusantara',
  businessDescription: 'Ekspansi gerai kopi UMKM di Yogyakarta.',
  category: 'Kuliner',
  location: 'Yogyakarta',
  requestedAmount: '10000.0000000',
  lockPeriodDays: 180,
  milestones: [
    {
      order: 1,
      title: 'Sewa & renovasi',
      description: 'Sewa + renovasi gerai',
      amount: '6000',
    },
    {
      order: 2,
      title: 'Peralatan & stok',
      description: 'Mesin kopi + bahan baku',
      amount: '4000',
    },
  ],
};

const emptyProposal = {
  id: 'p1',
  status: 'DRAFT',
  media: [] as unknown[],
};

describe('ProposalService', () => {
  let prisma: ReturnType<typeof makePrisma>;
  let storage: ReturnType<typeof makeStorage>;
  let service: ProposalService;

  beforeEach(() => {
    prisma = makePrisma();
    storage = makeStorage();
    service = new ProposalService(prisma, storage);
  });

  it('creates a proposal as DRAFT owned by the caller', async () => {
    prisma.proposal.create.mockResolvedValue(emptyProposal);

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
    expect(result.media).toEqual([]);
  });

  it('rejects a zero requestedAmount on create (no write)', async () => {
    await expect(
      service.create('u1', { ...dto, requestedAmount: '0' }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.proposal.create).not.toHaveBeenCalled();
  });

  it('nests milestone rows with onchainIndex = order - 1 on create', async () => {
    prisma.proposal.create.mockResolvedValue(emptyProposal);

    await service.create('u1', dto);

    expect(prisma.proposal.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          milestones: {
            create: expect.arrayContaining([
              expect.objectContaining({
                order: 1,
                onchainIndex: 0,
                amount: '6000',
              }),
              expect.objectContaining({
                order: 2,
                onchainIndex: 1,
                amount: '4000',
              }),
            ]) as unknown,
          },
        }) as unknown,
      }),
    );
  });

  it('rejects milestones that do not sum to requestedAmount (no write)', async () => {
    await expect(
      service.create('u1', {
        ...dto,
        milestones: [
          { order: 1, title: 'a', description: 'a', amount: '6000' },
          { order: 2, title: 'b', description: 'b', amount: '3000' }, // sums to 9000 ≠ 10000
        ],
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.proposal.create).not.toHaveBeenCalled();
  });

  it('rejects non-contiguous milestone orders (no write)', async () => {
    await expect(
      service.create('u1', {
        ...dto,
        milestones: [
          { order: 1, title: 'a', description: 'a', amount: '6000' },
          { order: 3, title: 'b', description: 'b', amount: '4000' }, // gap at 2
        ],
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.proposal.create).not.toHaveBeenCalled();
  });

  it('404s when getMine finds no proposal for the caller', async () => {
    prisma.proposal.findFirst.mockResolvedValue(null);
    await expect(service.getMine('u1', 'p1')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('maps media objectKeys to public URLs on getMine', async () => {
    prisma.proposal.findFirst.mockResolvedValue({
      id: 'p1',
      status: 'DRAFT',
      media: [
        {
          id: 'm1',
          kind: 'IMAGE',
          mimeType: 'image/jpeg',
          originalName: 'a.jpg',
          sizeBytes: 10,
          sortOrder: 0,
          objectKey: 'proposals/p1/images/a.jpg',
          createdAt: new Date('2026-01-01'),
        },
      ],
    });

    const result = await service.getMine('u1', 'p1');

    expect(result.media).toEqual([
      expect.objectContaining({
        id: 'm1',
        kind: 'IMAGE',
        url: 'https://cdn.example/proposals/p1/images/a.jpg',
      }),
    ]);
    expect(result.media[0]).not.toHaveProperty('objectKey');
  });

  it('updates a DRAFT proposal', async () => {
    prisma.proposal.findFirst.mockResolvedValue({ status: 'DRAFT' });
    prisma.proposal.update.mockResolvedValue(emptyProposal);

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
    prisma.proposal.update.mockResolvedValue({
      id: 'p1',
      status: 'SUBMITTED',
      media: [],
    });

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

describe('ProposalService media', () => {
  let prisma: ReturnType<typeof makePrisma>;
  let storage: ReturnType<typeof makeStorage>;
  let service: ProposalService;

  beforeEach(() => {
    prisma = makePrisma();
    storage = makeStorage();
    service = new ProposalService(prisma, storage);
    prisma.proposal.findFirst.mockResolvedValue({ status: 'DRAFT' });
    prisma.proposal.findFirstOrThrow.mockResolvedValue({
      id: 'p1',
      status: 'DRAFT',
      media: [],
    });
  });

  it('uploads images and documents and persists media rows', async () => {
    const image = fakeFile({
      mimetype: 'image/jpeg',
      originalname: 'toko.jpg',
      size: 200,
    });
    const doc = fakeFile({
      mimetype: 'application/pdf',
      originalname: 'deck.pdf',
      size: 500,
    });

    await service.addMedia('u1', 'p1', [image], [doc]);

    expect(storage.upload).toHaveBeenCalledTimes(2);
    expect(storage.upload).toHaveBeenCalledWith(
      expect.stringMatching(/^proposals\/p1\/images\/.+\.jpg$/),
      image.buffer,
      'image/jpeg',
    );
    expect(storage.upload).toHaveBeenCalledWith(
      expect.stringMatching(/^proposals\/p1\/documents\/.+\.pdf$/),
      doc.buffer,
      'application/pdf',
    );
    expect(prisma.proposalMedia.createMany).toHaveBeenCalledWith({
      data: expect.arrayContaining([
        expect.objectContaining({
          proposalId: 'p1',
          kind: ProposalMediaKind.IMAGE,
          mimeType: 'image/jpeg',
          originalName: 'toko.jpg',
          sizeBytes: 200,
          sortOrder: 0,
        }),
        expect.objectContaining({
          proposalId: 'p1',
          kind: ProposalMediaKind.DOCUMENT,
          mimeType: 'application/pdf',
          originalName: 'deck.pdf',
          sizeBytes: 500,
          sortOrder: 1,
        }),
      ]) as unknown,
    });
  });

  it('rejects when no files are provided', async () => {
    await expect(service.addMedia('u1', 'p1', [], [])).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(storage.upload).not.toHaveBeenCalled();
  });

  it('rejects when image cap would be exceeded', async () => {
    prisma.proposalMedia.groupBy.mockResolvedValue([
      {
        kind: ProposalMediaKind.IMAGE,
        _count: { _all: 5 },
        _max: { sortOrder: 4 },
      },
    ]);

    await expect(
      service.addMedia('u1', 'p1', [
        fakeFile({ mimetype: 'image/png' }),
      ]),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(storage.upload).not.toHaveBeenCalled();
  });

  it('rejects when document cap would be exceeded', async () => {
    prisma.proposalMedia.groupBy.mockResolvedValue([
      {
        kind: ProposalMediaKind.DOCUMENT,
        _count: { _all: 3 },
        _max: { sortOrder: 2 },
      },
    ]);

    await expect(
      service.addMedia('u1', 'p1', [], [
        fakeFile({ mimetype: 'application/pdf' }),
      ]),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects wrong image MIME at service layer', async () => {
    await expect(
      service.addMedia('u1', 'p1', [
        fakeFile({ mimetype: 'image/gif' }),
      ]),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('blocks media upload when proposal is not DRAFT', async () => {
    prisma.proposal.findFirst.mockResolvedValue({ status: 'SUBMITTED' });
    await expect(
      service.addMedia('u1', 'p1', [
        fakeFile({ mimetype: 'image/jpeg' }),
      ]),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('removes media from storage and DB', async () => {
    prisma.proposalMedia.findFirst.mockResolvedValue({
      id: 'm1',
      objectKey: 'proposals/p1/images/a.jpg',
    });

    await service.removeMedia('u1', 'p1', 'm1');

    expect(storage.delete).toHaveBeenCalledWith('proposals/p1/images/a.jpg');
    expect(prisma.proposalMedia.delete).toHaveBeenCalledWith({
      where: { id: 'm1' },
    });
  });

  it('404s when removing unknown media', async () => {
    prisma.proposalMedia.findFirst.mockResolvedValue(null);
    await expect(service.removeMedia('u1', 'p1', 'm1')).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(storage.delete).not.toHaveBeenCalled();
  });

  it('falls back to presigned URL when public URL is unavailable', async () => {
    storage.getPublicUrl.mockImplementation(() => {
      throw new Error('R2_PUBLIC_URL is not configured');
    });
    prisma.proposal.findFirst.mockResolvedValue({
      id: 'p1',
      status: 'DRAFT',
      media: [
        {
          id: 'm1',
          kind: 'DOCUMENT',
          mimeType: 'application/pdf',
          originalName: 'deck.pdf',
          sizeBytes: 1,
          sortOrder: 0,
          objectKey: 'proposals/p1/documents/x.pdf',
          createdAt: new Date(),
        },
      ],
    });

    const result = await service.getMine('u1', 'p1');
    expect(result.media[0].url).toBe('https://signed.example/file');
  });
});
