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
import { Prisma } from '../../generated/prisma/client';
import {
  CampaignDeployStatus,
  CampaignStatus,
  VaultStatus,
} from '../../generated/prisma/enums';
import { PrismaService } from '../prisma/prisma.service';
import { SorobanService } from '../soroban/soroban.service';
import { SECONDS_PER_DAY, toStroops } from './campaign.util';

export const CAMPAIGN_DEPLOY_QUEUE = 'campaign-deploy';
/** How often to sweep for not-yet-LIVE campaigns and re-enqueue them. */
const RECONCILE_INTERVAL_MS = 5 * 60 * 1000;
export interface CampaignDeployJob {
  campaignId: string;
}

/**
 * Drives a campaign's on-chain deploy as an idempotent, resumable state machine:
 *
 *   PENDING → DEPLOYING_TOKEN → DEPLOYING_CAMPAIGN → WIRING → LIVE   (FAILED on error)
 *
 * 1. deploy the campaign's `ShareToken` (restricted SEP-41, starts locked)
 * 2. deploy the `Campaign` contract (merged vault + distribution)
 * 3. `token.set_minter(campaign)` so only the campaign can mint shares
 *
 * Each step's resume point is derived from **what is already persisted** (token
 * address → campaign address → wire tx), not from `deployStatus` alone, so a retry
 * after a crash at any point resumes without redeploying. {@link SorobanService}
 * deploys are themselves idempotent (deterministic salt + on-chain pre-check), so
 * even a crash *mid-step* can't orphan or duplicate a contract.
 */
@Injectable()
export class CampaignDeployService implements OnApplicationBootstrap {
  private readonly logger = new Logger(CampaignDeployService.name);
  private readonly registryAddress: string;
  private readonly usdcAddress: string;
  private readonly shareTokenWasmHash: string;
  private readonly campaignWasmHash: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly soroban: SorobanService,
    config: ConfigService,
    @InjectQueue(CAMPAIGN_DEPLOY_QUEUE) private readonly queue: Queue,
  ) {
    this.registryAddress = config.getOrThrow<string>(
      'COMPLIANCE_REGISTRY_ADDRESS',
    );
    this.usdcAddress = config.getOrThrow<string>('USDC_CONTRACT_ADDRESS');
    this.shareTokenWasmHash = config.getOrThrow<string>(
      'SHARE_TOKEN_WASM_HASH',
    );
    this.campaignWasmHash = config.getOrThrow<string>('CAMPAIGN_WASM_HASH');
  }

  /** On boot, re-enqueue any campaign not yet LIVE (resume after a restart). */
  onApplicationBootstrap(): Promise<void> {
    return this.reconcile();
  }

  /**
   * Periodically re-enqueue any not-yet-LIVE campaign. Recovers deploys whose
   * queue job was lost without an app restart (e.g. Valkey restarted). Safe and
   * idempotent: {@link enqueue} dedupes against an in-flight job, and
   * {@link drive} no-ops once a campaign is LIVE.
   */
  @Interval(RECONCILE_INTERVAL_MS)
  async reconcile(): Promise<void> {
    const unfinished = await this.prisma.campaign.findMany({
      where: { deployStatus: { not: CampaignDeployStatus.LIVE } },
      select: { id: true },
    });
    await Promise.all(unfinished.map((c) => this.enqueue(c.id)));
    if (unfinished.length) {
      this.logger.log(
        `Re-enqueued ${unfinished.length} unfinished campaign deploy(s)`,
      );
    }
  }

  /**
   * Queue a deploy. `jobId = campaignId` dedupes concurrent adds; we clear any
   * stale (e.g. previously-failed) job first so a re-enqueue always re-attempts.
   */
  async enqueue(campaignId: string): Promise<void> {
    await this.queue.remove(campaignId).catch(() => undefined);
    await this.queue.add('deploy', { campaignId } satisfies CampaignDeployJob, {
      jobId: campaignId,
    });
  }

  /** Execute the next not-yet-done deploy step(s) for a campaign through to LIVE. */
  async drive(campaignId: string): Promise<void> {
    const campaign = await this.load(campaignId);
    if (campaign.deployStatus === CampaignDeployStatus.LIVE) return;

    try {
      const tokenAddress = await this.ensureToken(campaign);
      const campaignAddress = await this.ensureCampaign(campaign, tokenAddress);
      await this.ensureWired(campaign, tokenAddress, campaignAddress);
      await this.markLive(campaignId, campaignAddress);
      this.logger.log(
        `Campaign ${campaignId} LIVE (token ${tokenAddress}, campaign ${campaignAddress})`,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await this.prisma.campaign.update({
        where: { id: campaignId },
        data: {
          deployStatus: CampaignDeployStatus.FAILED,
          deployError: message,
          deployAttempts: { increment: 1 },
        },
      });
      this.logger.error(`Campaign ${campaignId} deploy failed: ${message}`);
      throw err; // surface to BullMQ for retry/backoff
    }
  }

  /** Step 1 — deploy the ShareToken if not already deployed. */
  private async ensureToken(campaign: LoadedCampaign): Promise<string> {
    const existing = campaign.projectToken?.contractAddress;
    if (existing) return existing;

    await this.setDeployStatus(
      campaign.id,
      CampaignDeployStatus.DEPLOYING_TOKEN,
    );
    const { contractAddress, txHash } = await this.soroban.deployFromWasmHash(
      this.shareTokenWasmHash,
      [
        this.soroban.addressArg(this.soroban.platformPublicKey), // owner
        this.soroban.addressArg(this.registryAddress), // registry
        this.soroban.stringArg(campaign.proposal.businessName), // name
        this.soroban.stringArg(campaign.projectToken.assetCode), // symbol
      ],
      this.soroban.saltFor(`${campaign.id}:token`),
    );
    await this.prisma.projectToken.update({
      where: { campaignId: campaign.id },
      data: { contractAddress, deployTxHash: txHash },
    });
    return contractAddress;
  }

  /** Step 2 — deploy the Campaign contract if not already deployed. */
  private async ensureCampaign(
    campaign: LoadedCampaign,
    tokenAddress: string,
  ): Promise<string> {
    if (campaign.contractAddress) return campaign.contractAddress;

    await this.setDeployStatus(
      campaign.id,
      CampaignDeployStatus.DEPLOYING_CAMPAIGN,
    );
    const lockPeriod = BigInt(
      campaign.proposal.lockPeriodDays * SECONDS_PER_DAY,
    );
    const { contractAddress, txHash } = await this.soroban.deployFromWasmHash(
      this.campaignWasmHash,
      [
        this.soroban.addressArg(this.soroban.platformPublicKey), // owner
        this.soroban.addressArg(tokenAddress), // token
        this.soroban.addressArg(this.registryAddress), // registry
        this.soroban.addressArg(this.usdcAddress), // usdc
        this.soroban.addressArg(campaign.proposal.entrepreneur.walletAddress), // business
        this.soroban.i128Arg(toStroops(campaign.goalAmount)), // goal
        this.soroban.u64Arg(lockPeriod), // lock_period
      ],
      this.soroban.saltFor(`${campaign.id}:campaign`),
    );
    await this.prisma.campaign.update({
      where: { id: campaign.id },
      data: { contractAddress, deployTxHash: txHash },
    });
    return contractAddress;
  }

  /** Step 3 — point the ShareToken's minter at the Campaign, if not already wired. */
  private async ensureWired(
    campaign: LoadedCampaign,
    tokenAddress: string,
    campaignAddress: string,
  ): Promise<void> {
    if (campaign.wireTxHash) return;

    await this.setDeployStatus(campaign.id, CampaignDeployStatus.WIRING);
    const { txHash } = await this.soroban.invokeContract(
      tokenAddress,
      'set_minter',
      [this.soroban.addressArg(campaignAddress)],
    );
    await this.prisma.campaign.update({
      where: { id: campaign.id },
      data: { wireTxHash: txHash },
    });
  }

  /** Step 4 — flip the campaign LIVE/ACTIVE and point the vault at the contract. */
  private async markLive(
    campaignId: string,
    campaignAddress: string,
  ): Promise<void> {
    await this.prisma.campaign.update({
      where: { id: campaignId },
      data: {
        deployStatus: CampaignDeployStatus.LIVE,
        status: CampaignStatus.ACTIVE,
        deployError: null,
        startAt: new Date(),
        vault: {
          update: {
            contractAddress: campaignAddress,
            status: VaultStatus.FUNDING,
          },
        },
      },
    });
  }

  private setDeployStatus(
    id: string,
    deployStatus: CampaignDeployStatus,
  ): Promise<unknown> {
    return this.prisma.campaign.update({
      where: { id },
      data: { deployStatus },
    });
  }

  private async load(campaignId: string): Promise<LoadedCampaign> {
    const campaign = await this.prisma.campaign.findUnique({
      where: { id: campaignId },
      include: {
        projectToken: true,
        proposal: {
          include: { entrepreneur: { select: { walletAddress: true } } },
        },
      },
    });
    if (!campaign || !campaign.projectToken) {
      throw new NotFoundException(
        `Campaign ${campaignId} not found or missing its token row`,
      );
    }
    return { ...campaign, projectToken: campaign.projectToken };
  }
}

/** Just the fields {@link CampaignDeployService.drive} reads (token row present). */
interface LoadedCampaign {
  id: string;
  contractAddress: string | null;
  goalAmount: Prisma.Decimal;
  deployStatus: CampaignDeployStatus | null;
  wireTxHash: string | null;
  projectToken: { contractAddress: string | null; assetCode: string };
  proposal: {
    businessName: string;
    lockPeriodDays: number;
    entrepreneur: { walletAddress: string };
  };
}
