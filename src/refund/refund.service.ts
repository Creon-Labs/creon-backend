import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '../../generated/prisma/client';
import { RefundClaimStatus, RefundStatus } from '../../generated/prisma/enums';
import { toStroops } from '../campaign/campaign.util';
import { PrismaService } from '../prisma/prisma.service';
import { SorobanService } from '../soroban/soroban.service';
import { SubmitRefundClaimDto } from './dto/submit-refund-claim.dto';

/** Refund fields returned by the per-campaign read endpoint. */
const REFUND_SELECT = {
  id: true,
  campaignId: true,
  reason: true,
  totalAmount: true,
  totalShares: true,
  totalClaimed: true,
  merkleRoot: true,
  snapshotLedger: true,
  status: true,
  createdAt: true,
} satisfies Prisma.RefundSelect;

/** Claim fields returned to the investor (their entitlement + proof). */
const REFUND_CLAIM_SELECT = {
  id: true,
  refundId: true,
  shareAmount: true,
  amount: true,
  leafIndex: true,
  merkleProof: true,
  claimTxHash: true,
  status: true,
  claimedAt: true,
  createdAt: true,
  refund: {
    select: { campaignId: true, status: true },
  },
} satisfies Prisma.RefundClaimSelect;

/**
 * The refund HTTP surface. A refund reuses the dividend prepare/submit relay shape —
 * the contract's `refund_claim()` requires the caller's own auth, so the investor
 * signs and the platform only fee-bumps. There is **no deposit relay**: the money is
 * the principal already in custody, and the on-chain `cancel()` + `set_refund()` steps
 * are driven by {@link RefundOrchestratorService}. The submit is idempotent on the
 * stable inner tx hash (`claimTxHash`, `@unique`).
 */
@Injectable()
export class RefundService {
  private readonly logger = new Logger(RefundService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly soroban: SorobanService,
  ) {}

  /** A campaign's refund (there is at most one), or null. Public read. */
  async getForCampaign(campaignId: string) {
    const campaign = await this.prisma.campaign.findUnique({
      where: { id: campaignId },
      select: { id: true },
    });
    if (!campaign) throw new NotFoundException('Campaign not found');
    return this.prisma.refund.findUnique({
      where: { campaignId },
      select: REFUND_SELECT,
    });
  }

  /** The caller's own refund entitlements (with proofs), newest first. */
  listMyClaims(userId: string) {
    return this.prisma.refundClaim.findMany({
      where: { investorId: userId },
      orderBy: { createdAt: 'desc' },
      select: REFUND_CLAIM_SELECT,
    });
  }

  /** Build an unsigned `refund_claim()` tx (investor as source) for signing. */
  async claimPrepare(
    userId: string,
    refundId: string,
  ): Promise<{ refundId: string; xdr: string }> {
    const wallet = await this.walletOf(userId);
    const { claim, campaignAddress } = await this.loadClaimable(
      userId,
      refundId,
    );

    const proof = claim.merkleProof.map((h) => Buffer.from(h, 'hex'));
    const xdr = await this.soroban.buildInvokeTransaction(
      wallet,
      campaignAddress,
      'refund_claim',
      [
        this.soroban.u32Arg(claim.leafIndex as number),
        this.soroban.addressArg(wallet),
        this.soroban.i128Arg(toStroops(claim.amount)),
        this.soroban.bytesVecArg(proof),
      ],
    );
    return { refundId, xdr };
  }

  /** Verify + fee-bump + submit a signed `refund_claim()`, then mark it CLAIMED. */
  async claimSubmit(
    userId: string,
    refundId: string,
    dto: SubmitRefundClaimDto,
  ) {
    const wallet = await this.walletOf(userId);

    // Idempotent on the (stable) inner tx hash.
    const txHash = this.soroban.transactionHash(dto.signedXdr);
    const existing = await this.prisma.refundClaim.findUnique({
      where: { claimTxHash: txHash },
      select: REFUND_CLAIM_SELECT,
    });
    if (existing) return existing;

    const { claim, campaignAddress } = await this.loadClaimable(
      userId,
      refundId,
    );

    const call = this.decodeOrThrow(dto.signedXdr);
    if (call.contractAddress !== campaignAddress) {
      throw new BadRequestException('Transaction targets a different contract');
    }
    if (call.functionName !== 'refund_claim') {
      throw new BadRequestException('Transaction is not a refund_claim() call');
    }
    const [indexArg, claimantArg, amountArg] = call.args;
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
        this.prisma.refundClaim.update({
          where: { id: claim.id },
          data: {
            status: RefundClaimStatus.CLAIMED,
            claimTxHash: txHash,
            claimedAt: new Date(),
          },
          select: REFUND_CLAIM_SELECT,
        }),
        this.prisma.refund.update({
          where: { id: refundId },
          data: { totalClaimed: { increment: claim.amount } },
        }),
      ]);
      this.logger.log(
        `Recorded refund claim ${updated.id} (${claim.amount.toString()} on ${refundId}, tx ${txHash})`,
      );
      return updated;
    } catch (err) {
      // Concurrent duplicate: the tx was already recorded under the unique txHash.
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === 'P2002'
      ) {
        const row = await this.prisma.refundClaim.findUnique({
          where: { claimTxHash: txHash },
          select: REFUND_CLAIM_SELECT,
        });
        if (row) return row;
      }
      throw err;
    }
  }

  // ---- helpers ----

  /** Load a refund claim the caller can act on, or throw. */
  private async loadClaimable(userId: string, refundId: string) {
    const claim = await this.prisma.refundClaim.findUnique({
      where: {
        refundId_investorId: { refundId, investorId: userId },
      },
      select: {
        id: true,
        amount: true,
        leafIndex: true,
        merkleProof: true,
        status: true,
        refund: {
          select: {
            status: true,
            campaign: { select: { contractAddress: true } },
          },
        },
      },
    });
    if (!claim) {
      throw new NotFoundException('No refund entitlement for this campaign');
    }
    if (claim.status === RefundClaimStatus.CLAIMED) {
      throw new ConflictException('Entitlement already claimed');
    }
    if (
      claim.refund.status !== RefundStatus.COMPLETED ||
      claim.leafIndex === null ||
      !claim.refund.campaign.contractAddress
    ) {
      throw new ConflictException('Refund is not ready to claim');
    }
    return {
      claim,
      campaignAddress: claim.refund.campaign.contractAddress,
    };
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
