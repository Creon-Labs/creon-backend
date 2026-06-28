import { ConflictException, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '../../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { StorageService } from '../storage/storage.service';
import { KycService } from './kyc.service';
import { UploadedFile } from './uploaded-file';

function makeFile(mimetype = 'image/jpeg'): UploadedFile {
  return { originalname: 'x', mimetype, size: 10, buffer: Buffer.from('data') };
}

function makePrisma() {
  return {
    entrepreneurProfile: {
      findUnique: jest.fn(),
      upsert: jest.fn(),
    },
  } as unknown as PrismaService & {
    entrepreneurProfile: { findUnique: jest.Mock; upsert: jest.Mock };
  };
}

function makeStorage() {
  return {
    upload: jest.fn().mockResolvedValue('key'),
  } as unknown as StorageService & { upload: jest.Mock };
}

const config = {
  getOrThrow: () => 'creon-kyc',
} as unknown as ConfigService;

const dto = { fullName: 'Budi', nationalId: '1234567890123456' };

describe('KycService', () => {
  let prisma: ReturnType<typeof makePrisma>;
  let storage: ReturnType<typeof makeStorage>;
  let service: KycService;

  beforeEach(() => {
    prisma = makePrisma();
    storage = makeStorage();
    service = new KycService(prisma, storage, config);
  });

  it('uploads both files to the private bucket and upserts PENDING', async () => {
    prisma.entrepreneurProfile.findUnique.mockResolvedValue(null);
    prisma.entrepreneurProfile.upsert.mockResolvedValue({
      status: 'PENDING',
      submittedAt: new Date(),
    });

    const result = await service.submit(
      'u1',
      dto,
      makeFile(),
      makeFile('image/png'),
    );

    expect(storage.upload).toHaveBeenCalledTimes(2);
    expect(storage.upload).toHaveBeenCalledWith(
      expect.stringContaining('kyc/u1/') as unknown,
      expect.any(Buffer) as unknown,
      expect.any(String) as unknown,
      'creon-kyc',
    );
    expect(prisma.entrepreneurProfile.upsert).toHaveBeenCalled();
    expect(result.status).toBe('PENDING');
  });

  it('blocks a re-submit while APPROVED (no upload)', async () => {
    prisma.entrepreneurProfile.findUnique.mockResolvedValue({
      status: 'APPROVED',
    });
    await expect(
      service.submit('u1', dto, makeFile(), makeFile()),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(storage.upload).not.toHaveBeenCalled();
  });

  it('blocks a re-submit while PENDING', async () => {
    prisma.entrepreneurProfile.findUnique.mockResolvedValue({
      status: 'PENDING',
    });
    await expect(
      service.submit('u1', dto, makeFile(), makeFile()),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('allows a re-submit after REJECTED', async () => {
    prisma.entrepreneurProfile.findUnique.mockResolvedValue({
      status: 'REJECTED',
    });
    prisma.entrepreneurProfile.upsert.mockResolvedValue({
      status: 'PENDING',
      submittedAt: new Date(),
    });
    const result = await service.submit('u1', dto, makeFile(), makeFile());
    expect(result.status).toBe('PENDING');
  });

  it('maps a NIK unique violation (P2002) to ConflictException', async () => {
    prisma.entrepreneurProfile.findUnique.mockResolvedValue(null);
    prisma.entrepreneurProfile.upsert.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('dup', {
        code: 'P2002',
        clientVersion: '7.8.0',
      }),
    );
    await expect(
      service.submit('u1', dto, makeFile(), makeFile()),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('404s when getMine finds no profile', async () => {
    prisma.entrepreneurProfile.findUnique.mockResolvedValue(null);
    await expect(service.getMine('u1')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});
