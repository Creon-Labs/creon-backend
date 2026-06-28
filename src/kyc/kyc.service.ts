import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'crypto';
import { Prisma } from '../../generated/prisma/client';
import { KycStatus } from '../../generated/prisma/enums';
import { PrismaService } from '../prisma/prisma.service';
import { StorageService } from '../storage/storage.service';
import { SubmitKycDto } from './dto/submit-kyc.dto';
import { UploadedFile } from './uploaded-file';

/**
 * Entrepreneur KYC submission. KTP/selfie images go into the PRIVATE bucket
 * (accessed later only via short-lived presigned URLs); the profile is upserted
 * to PENDING for an admin to review. A submission is blocked while already
 * APPROVED or PENDING; after REJECTED the same row is reused.
 */
@Injectable()
export class KycService {
  private readonly kycBucket: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    config: ConfigService,
  ) {
    this.kycBucket = config.getOrThrow<string>('R2_KYC_BUCKET');
  }

  async submit(
    userId: string,
    dto: SubmitKycDto,
    idCard: UploadedFile,
    selfie: UploadedFile,
  ): Promise<{ status: KycStatus; submittedAt: Date }> {
    const existing = await this.prisma.entrepreneurProfile.findUnique({
      where: { userId },
      select: { status: true },
    });
    if (existing?.status === KycStatus.APPROVED) {
      throw new ConflictException('KYC already approved');
    }
    if (existing?.status === KycStatus.PENDING) {
      throw new ConflictException('KYC already submitted, pending review');
    }

    const idCardImageKey = this.objectKey(userId, 'id-card', idCard);
    const selfieImageKey = this.objectKey(userId, 'selfie', selfie);
    await Promise.all([
      this.storage.upload(
        idCardImageKey,
        idCard.buffer,
        idCard.mimetype,
        this.kycBucket,
      ),
      this.storage.upload(
        selfieImageKey,
        selfie.buffer,
        selfie.mimetype,
        this.kycBucket,
      ),
    ]);

    const dateOfBirth = dto.dateOfBirth ? new Date(dto.dateOfBirth) : null;
    const submittedAt = new Date();
    try {
      return await this.prisma.entrepreneurProfile.upsert({
        where: { userId },
        create: {
          userId,
          fullName: dto.fullName,
          nationalId: dto.nationalId,
          dateOfBirth,
          idCardImageKey,
          selfieImageKey,
          status: KycStatus.PENDING,
          submittedAt,
        },
        update: {
          fullName: dto.fullName,
          nationalId: dto.nationalId,
          dateOfBirth,
          idCardImageKey,
          selfieImageKey,
          status: KycStatus.PENDING,
          submittedAt,
          // clear any prior review so a re-submission starts fresh
          reviewedById: null,
          reviewedAt: null,
          rejectionReason: null,
        },
        select: { status: true, submittedAt: true },
      });
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        throw new ConflictException('National ID already registered');
      }
      throw error;
    }
  }

  /** The caller's own KYC status (no raw object keys / admin ids exposed). */
  async getMine(userId: string) {
    const profile = await this.prisma.entrepreneurProfile.findUnique({
      where: { userId },
      select: {
        status: true,
        fullName: true,
        nationalId: true,
        submittedAt: true,
        reviewedAt: true,
        rejectionReason: true,
      },
    });
    if (!profile) {
      throw new NotFoundException('No KYC submission found');
    }
    return profile;
  }

  private objectKey(userId: string, kind: string, file: UploadedFile): string {
    const ext = file.mimetype === 'image/png' ? 'png' : 'jpg';
    return `kyc/${userId}/${kind}-${randomUUID()}.${ext}`;
  }
}
