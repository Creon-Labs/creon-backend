import { InjectQueue } from '@nestjs/bullmq';
import {
  Injectable,
  Logger,
  NotFoundException,
  OnApplicationBootstrap,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Interval } from '@nestjs/schedule';
import { Queue } from 'bullmq';
import { KycStatus, WhitelistStatus } from '../../generated/prisma/enums';
import { PrismaService } from '../prisma/prisma.service';
import { SorobanService } from '../soroban/soroban.service';

export const KYC_WHITELIST_QUEUE = 'kyc-whitelist';
/** How often to sweep for KYC profiles whose on-chain whitelist state is stale. */
const RECONCILE_INTERVAL_MS = 5 * 60 * 1000;
export interface KycWhitelistJob {
  userId: string;
}

/**
 * Syncs a KYC profile's wallet into the on-chain `ComplianceRegistry` as an
 * idempotent, resumable job:
 *
 *   APPROVED → registry.add(wallet)    → WHITELISTED
 *   REVOKED  → registry.remove(wallet) → REMOVED
 *
 * The desired on-chain state is **derived from the KYC review status**, so a retry
 * simply reconciles `whitelistStatus` toward it. On-chain `add`/`remove` are
 * themselves idempotent (re-add is a no-op), so a duplicate job or a crash mid-call
 * can never corrupt state. A thrown error marks the profile FAILED and is rethrown
 * so BullMQ retries with backoff.
 */
@Injectable()
export class KycWhitelistService implements OnApplicationBootstrap {
  private readonly logger = new Logger(KycWhitelistService.name);
  private readonly registryAddress: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly soroban: SorobanService,
    config: ConfigService,
    @InjectQueue(KYC_WHITELIST_QUEUE) private readonly queue: Queue,
  ) {
    this.registryAddress = config.getOrThrow<string>(
      'COMPLIANCE_REGISTRY_ADDRESS',
    );
  }

  /** On boot, re-enqueue any profile whose on-chain whitelist state is stale. */
  onApplicationBootstrap(): Promise<void> {
    return this.reconcile();
  }

  /**
   * Periodically re-enqueue any profile not yet reconciled on-chain. Recovers
   * syncs whose queue job was lost without an app restart (e.g. Valkey restarted).
   * Safe and idempotent: {@link enqueue} dedupes against an in-flight job, and
   * {@link drive} no-ops once a profile already matches its desired state.
   */
  @Interval(RECONCILE_INTERVAL_MS)
  async reconcile(): Promise<void> {
    const pending = await this.prisma.kycProfile.findMany({
      where: {
        OR: [
          {
            status: KycStatus.APPROVED,
            whitelistStatus: { not: WhitelistStatus.WHITELISTED },
          },
          {
            status: KycStatus.REVOKED,
            whitelistStatus: { not: WhitelistStatus.REMOVED },
          },
        ],
      },
      select: { userId: true },
    });
    await Promise.all(pending.map((p) => this.enqueue(p.userId)));
    if (pending.length) {
      this.logger.log(
        `Re-enqueued ${pending.length} pending whitelist sync(s)`,
      );
    }
  }

  /**
   * Queue a whitelist sync. `jobId = userId` dedupes concurrent adds; we clear any
   * stale (e.g. previously-failed) job first so a re-enqueue always re-attempts.
   */
  async enqueue(userId: string): Promise<void> {
    await this.queue.remove(userId).catch(() => undefined);
    await this.queue.add('sync', { userId } satisfies KycWhitelistJob, {
      jobId: userId,
      attempts: 5,
      backoff: { type: 'exponential', delay: 5000 },
      removeOnComplete: true,
    });
  }

  /** Reconcile a profile's on-chain whitelist state toward what its KYC status implies. */
  async drive(userId: string): Promise<void> {
    const profile = await this.load(userId);
    const desired = this.desiredFor(profile.status);
    if (!desired || profile.whitelistStatus === desired) return;

    try {
      if (desired === WhitelistStatus.WHITELISTED) {
        await this.add(profile);
      } else {
        await this.remove(profile);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await this.prisma.kycProfile.update({
        where: { userId },
        data: {
          whitelistStatus: WhitelistStatus.FAILED,
          whitelistError: message,
          whitelistAttempts: { increment: 1 },
        },
      });
      this.logger.error(`Whitelist sync for user ${userId} failed: ${message}`);
      throw err; // surface to BullMQ for retry/backoff
    }
  }

  /** The on-chain state a given KYC status should produce (null = no action). */
  private desiredFor(status: KycStatus): WhitelistStatus | null {
    if (status === KycStatus.APPROVED) return WhitelistStatus.WHITELISTED;
    if (status === KycStatus.REVOKED) return WhitelistStatus.REMOVED;
    return null;
  }

  /** `registry.add(wallet)` then persist the tx hash + WHITELISTED. */
  private async add(profile: LoadedKycProfile): Promise<void> {
    await this.setStatus(profile.userId, WhitelistStatus.ADDING);
    const { txHash } = await this.soroban.invokeContract(
      this.registryAddress,
      'add',
      [this.soroban.addressArg(profile.user.walletAddress)],
    );
    await this.prisma.kycProfile.update({
      where: { userId: profile.userId },
      data: {
        whitelistStatus: WhitelistStatus.WHITELISTED,
        whitelistTxHash: txHash,
        whitelistError: null,
      },
    });
    this.logger.log(
      `Whitelisted ${profile.user.walletAddress} (user ${profile.userId}, tx ${txHash})`,
    );
  }

  /** `registry.remove(wallet)` then persist the tx hash + REMOVED. */
  private async remove(profile: LoadedKycProfile): Promise<void> {
    await this.setStatus(profile.userId, WhitelistStatus.REMOVING);
    const { txHash } = await this.soroban.invokeContract(
      this.registryAddress,
      'remove',
      [this.soroban.addressArg(profile.user.walletAddress)],
    );
    await this.prisma.kycProfile.update({
      where: { userId: profile.userId },
      data: {
        whitelistStatus: WhitelistStatus.REMOVED,
        whitelistRemoveTxHash: txHash,
        whitelistError: null,
      },
    });
    this.logger.log(
      `Removed ${profile.user.walletAddress} from whitelist (user ${profile.userId}, tx ${txHash})`,
    );
  }

  private setStatus(
    userId: string,
    whitelistStatus: WhitelistStatus,
  ): Promise<unknown> {
    return this.prisma.kycProfile.update({
      where: { userId },
      data: { whitelistStatus },
    });
  }

  private async load(userId: string): Promise<LoadedKycProfile> {
    const profile = await this.prisma.kycProfile.findUnique({
      where: { userId },
      select: {
        userId: true,
        status: true,
        whitelistStatus: true,
        user: { select: { walletAddress: true } },
      },
    });
    if (!profile) {
      throw new NotFoundException(`KYC profile for user ${userId} not found`);
    }
    return profile;
  }
}

/** Just the fields {@link KycWhitelistService.drive} reads. */
interface LoadedKycProfile {
  userId: string;
  status: KycStatus;
  whitelistStatus: WhitelistStatus;
  user: { walletAddress: string };
}
