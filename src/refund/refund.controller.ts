import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  UseGuards,
} from '@nestjs/common';
import { Role } from '../../generated/prisma/enums';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { ApprovedInvestorGuard } from '../auth/guards/approved-investor.guard';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import type { AuthUser } from '../auth/types/auth-user';
import { SubmitRefundClaimDto } from './dto/submit-refund-claim.dto';
import { RefundService } from './refund.service';

/**
 * Refund endpoints. The admin cancel that *opens* a refund lives in the admin module
 * (mirroring proposal approval); here we expose the per-campaign refund read and the
 * investor claim relay. The claim relay is investor-only; the campaign refund read is
 * any authenticated user.
 */
@Controller()
@UseGuards(JwtAuthGuard, RolesGuard)
export class RefundController {
  constructor(private readonly refunds: RefundService) {}

  /** The campaign's refund (status + totals), or null if none was opened. */
  @Get('campaigns/:campaignId/refund')
  getForCampaign(@Param('campaignId', ParseUUIDPipe) campaignId: string) {
    return this.refunds.getForCampaign(campaignId);
  }

  // ---- claim (investor) ----

  /** List the caller's own refund entitlements (with Merkle proofs). */
  @Get('refunds/mine')
  @Roles(Role.INVESTOR)
  listMine(@CurrentUser() user: AuthUser) {
    return this.refunds.listMyClaims(user.userId);
  }

  /** Build an unsigned `refund_claim()` tx for the investor's wallet to sign. */
  @Post('refunds/:refundId/claim/prepare')
  @HttpCode(HttpStatus.OK)
  @Roles(Role.INVESTOR)
  @UseGuards(ApprovedInvestorGuard)
  claimPrepare(
    @CurrentUser() user: AuthUser,
    @Param('refundId', ParseUUIDPipe) refundId: string,
  ) {
    return this.refunds.claimPrepare(user.userId, refundId);
  }

  /** Submit the signed `refund_claim()` tx; backend fee-bumps, submits, and records it. */
  @Post('refunds/:refundId/claim')
  @Roles(Role.INVESTOR)
  @UseGuards(ApprovedInvestorGuard)
  claimSubmit(
    @CurrentUser() user: AuthUser,
    @Param('refundId', ParseUUIDPipe) refundId: string,
    @Body() dto: SubmitRefundClaimDto,
  ) {
    return this.refunds.claimSubmit(user.userId, refundId, dto);
  }
}
