import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '../../generated/prisma/client';
import {
  CampaignDeployStatus,
  ClaimStatus,
  DistributionStatus,
} from '../../generated/prisma/enums';
import { fromStroops, toStroops } from '../campaign/campaign.util';
import { PrismaService } from '../prisma/prisma.service';
import { SorobanService } from '../soroban/soroban.service';
import { DistributionOrchestratorService } from './distribution-orchestrator.service';
import { DepositProfitDto } from './dto/deposit-profit.dto';
import { SubmitTxDto } from './dto/submit-tx.dto';

/** Distribution fields returned by the campaign + deposit endpoints. */
const DISTRIBUTION_SELECT = {
  id: true,
  campaignId: true,
  onchainId: true,
  totalAmount: true,
  totalShares: true,
  rewardPerShare: true,
  totalClaimed: true,
  merkleRoot: true,
  snapshotLedger: true,
  status: true,
  distributedAt: true,
  createdAt: true,
} satisfies Prisma.ProfitDistributionSelect;

/** Claim fields returned to the investor (their entitlement + proof). */
const CLAIM_SELECT = {
  id: true,
  distributionId: true,
  shareAmount: true,
  amount: true,
  leafIndex: true,
  merkleProof: true,
  claimTxHash: true,
  status: true,
  claimedAt: true,
  createdAt: true,
  distribution: {
    select: { onchainId: true, campaignId: true, status: true },
  },
} satisfies Prisma.DistributionClaimSelect;

/**
 * The dividend (bagi hasil) HTTP surface (Phase 6). Two prepare/submit relays that
 * mirror the invest flow — the contract's `deposit_profit()` and `claim()` both
 * require the caller's own auth, so the caller signs and the platform only
 * fee-bumps:
 *
 *  - **Deposit** (entrepreneur): {@link depositPrepare}/{@link depositSubmit} pull
 *    profit USDC into the campaign; a successful submit creates a
 *    `ProfitDistribution` (PENDING) and enqueues the snapshot orchestrator.
 *  - **Claim** (investor): {@link claimPrepare}/{@link claimSubmit} pay a holder
 *    their Merkle-pinned entitlement and mark the `DistributionClaim` CLAIMED.
 *
 * Both submits are idempotent on the stable inner tx hash (`depositTxHash` /
 * `claimTxHash`, each `@unique`).
 */
@Injectable()
export class DistributionService {
  private readonly logger = new Logger(DistributionService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly soroban: SorobanService,
    private readonly orchestrator: DistributionOrchestratorService,
  ) {}

  // ---- deposit (entrepreneur) ----

  /** Build an unsigned `deposit_profit()` tx (business as source) for signing. */
  async depositPrepare(
    userId: string,
    campaignId: string,
    dto: DepositProfitDto,
  ): Promise<{ campaignId: string; xdr: string }> {
    if (Number(dto.amount) <= 0) {
      throw new BadRequestException('amount must be greater than zero');
    }
    const wallet = await this.walletOf(userId);
    const campaign = await this.loadOwnedLiveCampaign(userId, campaignId);

    const xdr = await this.soroban.buildInvokeTransaction(
      wallet,
      campaign.contractAddress,
      'deposit_profit',
      [
        this.soroban.addressArg(wallet),
        this.soroban.i128Arg(toStroops(dto.amount)),
      ],
    );
    return { campaignId, xdr };
  }

  /** Verify + fee-bump + submit a signed `deposit_profit()`, then open a distribution. */
  async depositSubmit(userId: string, campaignId: string, dto: SubmitTxDto) {
    const wallet = await this.walletOf(userId);
    const campaign = await this.loadOwnedLiveCampaign(userId, campaignId);

    // Idempotent on the (stable) inner tx hash.
    const txHash = this.soroban.transactionHash(dto.signedXdr);
    const existing = await this.prisma.profitDistribution.findUnique({
      where: { depositTxHash: txHash },
      select: DISTRIBUTION_SELECT,
    });
    if (existing) return existing;

    const call = this.decodeOrThrow(dto.signedXdr);
    if (call.contractAddress !== campaign.contractAddress) {
      throw new BadRequestException('Transaction targets a different contract');
    }
    if (call.functionName !== 'deposit_profit') {
      throw new BadRequestException(
        'Transaction is not a deposit_profit() call',
      );
    }
    const [fromArg, amountArg] = call.args;
    if (!fromArg || this.soroban.readAddress(fromArg) !== wallet) {
      throw new BadRequestException('Transaction depositor is not the caller');
    }
    const amountStroops = amountArg ? this.soroban.readI128(amountArg) : 0n;
    if (amountStroops <= 0n) {
      throw new BadRequestException(
        'Deposited amount must be greater than zero',
      );
    }

    const { result } = await this.soroban.submitSignedTransaction(
      dto.signedXdr,
    );

    const distribution = await this.createDistribution(
      campaignId,
      txHash,
      fromStroops(amountStroops),
      result.ledger,
    );
    await this.orchestrator.enqueue(distribution.id);
    this.logger.log(
      `Recorded profit deposit ${distribution.id} (${fromStroops(amountStroops).toString()} on ${campaignId}, tx ${txHash})`,
    );
    return distribution;
  }

  /** A campaign's distributions, newest first (public read). */
  async listForCampaign(campaignId: string) {
    const campaign = await this.prisma.campaign.findUnique({
      where: { id: campaignId },
      select: { id: true },
    });
    if (!campaign) throw new NotFoundException('Campaign not found');
    return this.prisma.profitDistribution.findMany({
      where: { campaignId },
      orderBy: { onchainId: 'desc' },
      select: DISTRIBUTION_SELECT,
    });
  }

  // ---- claim (investor) ----

  /** The caller's own entitlements (with proofs), newest first. */
  listMyClaims(userId: string) {
    return this.prisma.distributionClaim.findMany({
      where: { investorId: userId },
      orderBy: { createdAt: 'desc' },
      select: CLAIM_SELECT,
    });
  }

  /** Build an unsigned `claim()` tx (investor as source) for signing. */
  async claimPrepare(
    userId: string,
    distributionId: string,
  ): Promise<{ distributionId: string; xdr: string }> {
    const wallet = await this.walletOf(userId);
    const { claim, campaignAddress } = await this.loadClaimable(
      userId,
      distributionId,
    );

    const proof = claim.merkleProof.map((h) => Buffer.from(h, 'hex'));
    const xdr = await this.soroban.buildInvokeTransaction(
      wallet,
      campaignAddress,
      'claim',
      [
        this.soroban.u32Arg(claim.distribution.onchainId),
        this.soroban.u32Arg(claim.leafIndex as number),
        this.soroban.addressArg(wallet),
        this.soroban.i128Arg(toStroops(claim.amount)),
        this.soroban.bytesVecArg(proof),
      ],
    );
    return { distributionId, xdr };
  }

  /** Verify + fee-bump + submit a signed `claim()`, then mark it CLAIMED. */
  async claimSubmit(userId: string, distributionId: string, dto: SubmitTxDto) {
    const wallet = await this.walletOf(userId);

    // Idempotent on the (stable) inner tx hash.
    const txHash = this.soroban.transactionHash(dto.signedXdr);
    const existing = await this.prisma.distributionClaim.findUnique({
      where: { claimTxHash: txHash },
      select: CLAIM_SELECT,
    });
    if (existing) return existing;

    const { claim, campaignAddress } = await this.loadClaimable(
      userId,
      distributionId,
    );

    const call = this.decodeOrThrow(dto.signedXdr);
    if (call.contractAddress !== campaignAddress) {
      throw new BadRequestException('Transaction targets a different contract');
    }
    if (call.functionName !== 'claim') {
      throw new BadRequestException('Transaction is not a claim() call');
    }
    const [idArg, indexArg, claimantArg, amountArg] = call.args;
    if (
      !idArg ||
      this.soroban.readU32(idArg) !== claim.distribution.onchainId
    ) {
      throw new BadRequestException('Transaction distribution id mismatch');
    }
    if (!indexArg || this.soroban.readU32(indexArg) !== claim.leafIndex) {
      throw new BadRequestException('Transaction leaf index mismatch');
    }
    if (!claimantArg || this.soroban.readAddress(claimantArg) !== wallet) {
      throw new BadRequestException('Transaction claimant is not the caller');
    }
    if (
      !amountArg ||
      this.soroban.readI128(amountArg) !== toStroops(claim.amount)
    ) {
      throw new BadRequestException('Transaction amount mismatch');
    }

    await this.soroban.submitSignedTransaction(dto.signedXdr);

    try {
      const [updated] = await this.prisma.$transaction([
        this.prisma.distributionClaim.update({
          where: { id: claim.id },
          data: {
            status: ClaimStatus.CLAIMED,
            claimTxHash: txHash,
            claimedAt: new Date(),
          },
          select: CLAIM_SELECT,
        }),
        this.prisma.profitDistribution.update({
          where: { id: distributionId },
          data: { totalClaimed: { increment: claim.amount } },
        }),
      ]);
      this.logger.log(
        `Recorded claim ${updated.id} (${claim.amount.toString()} on ${distributionId}, tx ${txHash})`,
      );
      return updated;
    } catch (err) {
      // Concurrent duplicate: the tx was already recorded under the unique txHash.
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === 'P2002'
      ) {
        const row = await this.prisma.distributionClaim.findUnique({
          where: { claimTxHash: txHash },
          select: CLAIM_SELECT,
        });
        if (row) return row;
      }
      throw err;
    }
  }

  // ---- helpers ----

  /**
   * Create the `ProfitDistribution` for a confirmed deposit, allocating the next
   * per-campaign `onchainId`. Retries on a concurrent id race and returns the winner
   * if the same deposit tx was recorded concurrently (both guarded by unique
   * constraints).
   */
  private async createDistribution(
    campaignId: string,
    depositTxHash: string,
    totalAmount: Prisma.Decimal,
    snapshotLedger: number,
  ) {
    for (let attempt = 0; ; attempt++) {
      const onchainId = await this.prisma.profitDistribution.count({
        where: { campaignId },
      });
      try {
        return await this.prisma.profitDistribution.create({
          data: {
            campaignId,
            onchainId,
            totalAmount,
            depositTxHash,
            snapshotLedger: BigInt(snapshotLedger),
            status: DistributionStatus.PENDING,
          },
          select: DISTRIBUTION_SELECT,
        });
      } catch (err) {
        if (
          !(err instanceof Prisma.PrismaClientKnownRequestError) ||
          err.code !== 'P2002'
        ) {
          throw err;
        }
        // Same deposit tx recorded concurrently → return the winner.
        const dup = await this.prisma.profitDistribution.findUnique({
          where: { depositTxHash },
          select: DISTRIBUTION_SELECT,
        });
        if (dup) return dup;
        // Otherwise an onchainId race — recompute the count and retry (bounded).
        if (attempt >= 4) {
          throw new ConflictException(
            'Could not allocate an on-chain distribution id',
          );
        }
      }
    }
  }

  /** Load a claim the caller can act on, or throw. */
  private async loadClaimable(userId: string, distributionId: string) {
    const claim = await this.prisma.distributionClaim.findUnique({
      where: {
        distributionId_investorId: { distributionId, investorId: userId },
      },
      select: {
        id: true,
        amount: true,
        leafIndex: true,
        merkleProof: true,
        status: true,
        distribution: {
          select: {
            onchainId: true,
            status: true,
            campaign: { select: { contractAddress: true } },
          },
        },
      },
    });
    if (!claim) {
      throw new NotFoundException('No entitlement for this distribution');
    }
    if (claim.status === ClaimStatus.CLAIMED) {
      throw new ConflictException('Entitlement already claimed');
    }
    if (
      claim.distribution.status !== DistributionStatus.COMPLETED ||
      claim.leafIndex === null ||
      !claim.distribution.campaign.contractAddress
    ) {
      throw new ConflictException('Distribution is not ready to claim');
    }
    return {
      claim,
      campaignAddress: claim.distribution.campaign.contractAddress,
    };
  }

  private async loadOwnedLiveCampaign(
    userId: string,
    campaignId: string,
  ): Promise<{ id: string; contractAddress: string }> {
    const campaign = await this.prisma.campaign.findUnique({
      where: { id: campaignId },
      select: {
        id: true,
        contractAddress: true,
        deployStatus: true,
        proposal: { select: { entrepreneurId: true } },
      },
    });
    if (!campaign) throw new NotFoundException('Campaign not found');
    if (campaign.proposal.entrepreneurId !== userId) {
      throw new ForbiddenException('You do not own this campaign');
    }
    if (
      campaign.deployStatus !== CampaignDeployStatus.LIVE ||
      !campaign.contractAddress
    ) {
      throw new ConflictException('Campaign is not live');
    }
    return { id: campaign.id, contractAddress: campaign.contractAddress };
  }

  private decodeOrThrow(signedXdr: string) {
    try {
      return this.soroban.decodeInvokeContract(signedXdr);
    } catch {
      throw new BadRequestException('Malformed or non-invocation transaction');
    }
  }

  private async walletOf(userId: string): Promise<string> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { walletAddress: true },
    });
    if (!user) throw new NotFoundException('User not found');
    return user.walletAddress;
  }
}
