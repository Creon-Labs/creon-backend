import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { KycStatus } from '../../generated/prisma/enums';
import { PrismaService } from '../prisma/prisma.service';
import { StorageService } from '../storage/storage.service';

/** Short lifetime for the presigned KYC image URLs handed to admins. */
const PRESIGN_TTL_SECONDS = 300;

/**
 * Admin-side KYC review: list submissions (with short-lived presigned image
 * URLs from the private bucket) and approve / reject pending ones.
 */
@Injectable()
export class AdminService {
  private readonly kycBucket: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    config: ConfigService,
  ) {
    this.kycBucket = config.getOrThrow<string>('R2_KYC_BUCKET');
  }

  async list(status: KycStatus) {
    const profiles = await this.prisma.entrepreneurProfile.findMany({
      where: { status },
      orderBy: { submittedAt: 'asc' },
      select: {
        userId: true,
        fullName: true,
        nationalId: true,
        status: true,
        submittedAt: true,
        rejectionReason: true,
        idCardImageKey: true,
        selfieImageKey: true,
        user: { select: { walletAddress: true, email: true } },
      },
    });

    return Promise.all(
      profiles.map(async (p) => ({
        userId: p.userId,
        fullName: p.fullName,
        nationalId: p.nationalId,
        status: p.status,
        submittedAt: p.submittedAt,
        rejectionReason: p.rejectionReason,
        walletAddress: p.user.walletAddress,
        email: p.user.email,
        idCardUrl: await this.storage.getPresignedDownloadUrl(
          p.idCardImageKey,
          PRESIGN_TTL_SECONDS,
          this.kycBucket,
        ),
        selfieUrl: p.selfieImageKey
          ? await this.storage.getPresignedDownloadUrl(
              p.selfieImageKey,
              PRESIGN_TTL_SECONDS,
              this.kycBucket,
            )
          : null,
      })),
    );
  }

  async approve(userId: string, adminId: string) {
    await this.assertPending(userId);
    return this.prisma.entrepreneurProfile.update({
      where: { userId },
      data: {
        status: KycStatus.APPROVED,
        reviewedById: adminId,
        reviewedAt: new Date(),
        rejectionReason: null,
      },
      select: { userId: true, status: true, reviewedAt: true },
    });
  }

  async reject(userId: string, adminId: string, reason: string) {
    await this.assertPending(userId);
    return this.prisma.entrepreneurProfile.update({
      where: { userId },
      data: {
        status: KycStatus.REJECTED,
        reviewedById: adminId,
        reviewedAt: new Date(),
        rejectionReason: reason,
      },
      select: {
        userId: true,
        status: true,
        reviewedAt: true,
        rejectionReason: true,
      },
    });
  }

  /** A review action only applies to a profile that is awaiting review. */
  private async assertPending(userId: string): Promise<void> {
    const profile = await this.prisma.entrepreneurProfile.findUnique({
      where: { userId },
      select: { status: true },
    });
    if (!profile) {
      throw new NotFoundException('KYC submission not found');
    }
    if (profile.status !== KycStatus.PENDING) {
      throw new ConflictException('KYC submission is not pending review');
    }
  }
}
