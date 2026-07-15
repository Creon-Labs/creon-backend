import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '../../generated/prisma/client';
import {
  CampaignDeployStatus,
  CampaignStatus,
  InvestmentStatus,
} from '../../generated/prisma/enums';
import { fromStroops, toStroops } from '../campaign/campaign.util';
import { PrismaService } from '../prisma/prisma.service';
import { SorobanService } from '../soroban/soroban.service';
import { CampaignFundingCloseService } from '../campaign/campaign-funding-close.service';
import { PrepareInvestmentDto } from './dto/prepare-investment.dto';
import { SubmitInvestmentDto } from './dto/submit-investment.dto';

/** Fields returned to the investor for their own investment records. */
const INVESTMENT_SELECT = {
  id: true,
  campaignId: true,
  amount: true,
  lpTokens: true,
  txHash: true,
  status: true,
  investedAt: true,
  createdAt: true,
} satisfies Prisma.InvestmentSelect;

/**
 * The investment flow (Phase 4). The campaign contract's `invest()` requires the
 * investor's own auth and pulls their USDC, so the investor must sign — the
 * platform can only sponsor the fee. Two steps:
 *
 *  1. {@link prepare} — build an unsigned `invest()` tx sourced at the investor
 *     and return its XDR for the wallet to sign.
 *  2. {@link submit} — verify the signed tx really is this investor's `invest()`
 *     on this campaign, fee-bump + submit it, then record the `Investment`
 *     (CONFIRMED) and bump `raisedAmount` / `vault.totalDeposited`.
 *
 * Synchronous; idempotent on the stable inner tx hash so a retried submit
 * returns the already-recorded investment instead of re-submitting.
 */
@Injectable()
export class InvestmentService {
  private readonly logger = new Logger(InvestmentService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly soroban: SorobanService,
    private readonly fundingClose: CampaignFundingCloseService,
  ) {}

  /** Build an unsigned `invest()` tx (investor as source) for the wallet to sign. */
  async prepare(
    userId: string,
    campaignId: string,
    dto: PrepareInvestmentDto,
  ): Promise<{ campaignId: string; xdr: string }> {
    if (Number(dto.amount) <= 0) {
      throw new BadRequestException('amount must be greater than zero');
    }
    const wallet = await this.walletOf(userId);
    const campaign = await this.loadInvestable(campaignId);

    const xdr = await this.soroban.buildInvokeTransaction(
      wallet,
      campaign.contractAddress,
      'invest',
      [
        this.soroban.addressArg(wallet),
        this.soroban.i128Arg(toStroops(dto.amount)),
      ],
    );
    return { campaignId, xdr };
  }

  /** Verify + fee-bump + submit an investor-signed `invest()` tx, then record it. */
  async submit(userId: string, campaignId: string, dto: SubmitInvestmentDto) {
    const wallet = await this.walletOf(userId);
    const campaign = await this.loadInvestable(campaignId);

    // Idempotent on the (stable) inner tx hash: a retried POST returns the
    // already-recorded investment instead of re-submitting a consumed tx.
    const txHash = this.soroban.transactionHash(dto.signedXdr);
    const existing = await this.prisma.investment.findUnique({
      where: { txHash },
      select: INVESTMENT_SELECT,
    });
    if (existing) return existing;

    // Verify the signed tx really is this investor's invest() on this campaign
    // before we submit it (and sponsor its fee).
    const call = this.decodeOrThrow(dto.signedXdr);
    if (call.contractAddress !== campaign.contractAddress) {
      throw new BadRequestException('Transaction targets a different contract');
    }
    if (call.functionName !== 'invest') {
      throw new BadRequestException('Transaction is not an invest() call');
    }
    const [investorArg, amountArg] = call.args;
    if (!investorArg || this.soroban.readAddress(investorArg) !== wallet) {
      throw new BadRequestException('Transaction investor is not the caller');
    }
    const amountStroops = amountArg ? this.soroban.readI128(amountArg) : 0n;
    if (amountStroops <= 0n) {
      throw new BadRequestException(
        'Invested amount must be greater than zero',
      );
    }

    await this.soroban.submitSignedTransaction(dto.signedXdr);

    const amount = fromStroops(amountStroops);
    try {
      // The contract is the source of truth; events/indexing may lag this submit.
      const onChainRaised = fromStroops(
        this.soroban.readI128(
          await this.soroban.simulateRead(
            campaign.contractAddress,
            'raised',
            [],
          ),
        ),
      );
      const [investment] = await this.prisma.$transaction([
        this.prisma.investment.create({
          data: {
            campaignId,
            investorId: userId,
            amount,
            lpTokens: amount, // shares minted 1:1 with USDC invested
            txHash,
            status: InvestmentStatus.CONFIRMED,
            investedAt: new Date(),
          },
          select: INVESTMENT_SELECT,
        }),
        this.prisma.campaign.update({
          where: { id: campaignId },
          data: {
            raisedAmount: onChainRaised,
            vault: { update: { totalDeposited: { increment: amount } } },
          },
        }),
      ]);
      this.logger.log(
        `Recorded investment ${investment.id} (${amount.toString()} on ${campaignId}, tx ${txHash})`,
      );
      if (onChainRaised.greaterThanOrEqualTo(campaign.goalAmount)) {
        await this.prisma.campaign.updateMany({
          where: { id: campaignId, status: CampaignStatus.ACTIVE },
          data: { status: CampaignStatus.GOAL_REACHED },
        });
        await this.fundingClose.enqueue(campaignId);
      }
      return investment;
    } catch (err) {
      // Concurrent duplicate: the tx was already recorded under the unique txHash.
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === 'P2002'
      ) {
        const row = await this.prisma.investment.findUnique({
          where: { txHash },
          select: INVESTMENT_SELECT,
        });
        if (row) return row;
      }
      throw err;
    }
  }

  /** List the caller's own investments, newest first. */
  listMine(userId: string) {
    return this.prisma.investment.findMany({
      where: { investorId: userId },
      orderBy: { createdAt: 'desc' },
      select: INVESTMENT_SELECT,
    });
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

  /** Load a campaign and assert it is open for investment (LIVE + ACTIVE). */
  private async loadInvestable(campaignId: string): Promise<{
    id: string;
    contractAddress: string;
    goalAmount: Prisma.Decimal;
  }> {
    const campaign = await this.prisma.campaign.findUnique({
      where: { id: campaignId },
      select: {
        id: true,
        contractAddress: true,
        status: true,
        deployStatus: true,
        endAt: true,
        goalAmount: true,
      },
    });
    if (!campaign) {
      throw new NotFoundException('Campaign not found');
    }
    if (
      campaign.deployStatus !== CampaignDeployStatus.LIVE ||
      campaign.status !== CampaignStatus.ACTIVE ||
      !campaign.contractAddress
    ) {
      throw new ConflictException('Campaign is not open for investment');
    }
    if (campaign.endAt && campaign.endAt.getTime() <= Date.now()) {
      void this.fundingClose.enqueue(campaign.id);
      throw new ConflictException('Campaign funding deadline has passed');
    }
    return {
      id: campaign.id,
      contractAddress: campaign.contractAddress,
      goalAmount: campaign.goalAmount,
    };
  }
}
