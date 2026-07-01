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
import { ApprovedEntrepreneurGuard } from '../auth/guards/approved-entrepreneur.guard';
import { ApprovedInvestorGuard } from '../auth/guards/approved-investor.guard';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import type { AuthUser } from '../auth/types/auth-user';
import { DistributionService } from './distribution.service';
import { DepositProfitDto } from './dto/deposit-profit.dto';
import { SubmitTxDto } from './dto/submit-tx.dto';

/**
 * Dividend (bagi hasil) endpoints. Mixed roles, so guards/roles are per-method:
 * the deposit relay is entrepreneur-only (owns the campaign), the claim relay is
 * investor-only, and the per-campaign list is any authenticated user.
 */
@Controller()
@UseGuards(JwtAuthGuard, RolesGuard)
export class DistributionController {
  constructor(private readonly distributions: DistributionService) {}

  // ---- deposit (campaign owner / entrepreneur) ----

  /** Build an unsigned `deposit_profit()` tx for the business's wallet to sign. */
  @Post('campaigns/:campaignId/distributions/deposit/prepare')
  @HttpCode(HttpStatus.OK)
  @Roles(Role.ENTREPRENEUR)
  @UseGuards(ApprovedEntrepreneurGuard)
  depositPrepare(
    @CurrentUser() user: AuthUser,
    @Param('campaignId', ParseUUIDPipe) campaignId: string,
    @Body() dto: DepositProfitDto,
  ) {
    return this.distributions.depositPrepare(user.userId, campaignId, dto);
  }

  /** Submit the signed deposit; backend fee-bumps, submits, and opens a distribution. */
  @Post('campaigns/:campaignId/distributions/deposit')
  @Roles(Role.ENTREPRENEUR)
  @UseGuards(ApprovedEntrepreneurGuard)
  depositSubmit(
    @CurrentUser() user: AuthUser,
    @Param('campaignId', ParseUUIDPipe) campaignId: string,
    @Body() dto: SubmitTxDto,
  ) {
    return this.distributions.depositSubmit(user.userId, campaignId, dto);
  }

  /** List a campaign's profit distributions. */
  @Get('campaigns/:campaignId/distributions')
  listForCampaign(@Param('campaignId', ParseUUIDPipe) campaignId: string) {
    return this.distributions.listForCampaign(campaignId);
  }

  // ---- claim (investor) ----

  /** List the caller's own entitlements (with Merkle proofs). */
  @Get('distributions/mine')
  @Roles(Role.INVESTOR)
  listMine(@CurrentUser() user: AuthUser) {
    return this.distributions.listMyClaims(user.userId);
  }

  /** Build an unsigned `claim()` tx for the investor's wallet to sign. */
  @Post('distributions/:distributionId/claim/prepare')
  @HttpCode(HttpStatus.OK)
  @Roles(Role.INVESTOR)
  @UseGuards(ApprovedInvestorGuard)
  claimPrepare(
    @CurrentUser() user: AuthUser,
    @Param('distributionId', ParseUUIDPipe) distributionId: string,
  ) {
    return this.distributions.claimPrepare(user.userId, distributionId);
  }

  /** Submit the signed `claim()` tx; backend fee-bumps, submits, and records it. */
  @Post('distributions/:distributionId/claim')
  @Roles(Role.INVESTOR)
  @UseGuards(ApprovedInvestorGuard)
  claimSubmit(
    @CurrentUser() user: AuthUser,
    @Param('distributionId', ParseUUIDPipe) distributionId: string,
    @Body() dto: SubmitTxDto,
  ) {
    return this.distributions.claimSubmit(user.userId, distributionId, dto);
  }
}
