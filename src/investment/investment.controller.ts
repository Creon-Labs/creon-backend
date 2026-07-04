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
import { ResponseMessage } from '../common/decorators/response-message.decorator';
import { PrepareInvestmentDto } from './dto/prepare-investment.dto';
import { SubmitInvestmentDto } from './dto/submit-investment.dto';
import { InvestmentService } from './investment.service';

@Controller()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.INVESTOR)
export class InvestmentController {
  constructor(private readonly investments: InvestmentService) {}

  /** Build an unsigned `invest()` tx for the investor's wallet to sign. */
  @Post('campaigns/:campaignId/investments/prepare')
  @HttpCode(HttpStatus.OK)
  @UseGuards(ApprovedInvestorGuard)
  @ResponseMessage('Investment transaction prepared')
  prepare(
    @CurrentUser() user: AuthUser,
    @Param('campaignId', ParseUUIDPipe) campaignId: string,
    @Body() dto: PrepareInvestmentDto,
  ) {
    return this.investments.prepare(user.userId, campaignId, dto);
  }

  /** Submit the signed `invest()` tx; backend fee-bumps, submits, and records it. */
  @Post('campaigns/:campaignId/investments')
  @UseGuards(ApprovedInvestorGuard)
  @ResponseMessage('Investment recorded')
  submit(
    @CurrentUser() user: AuthUser,
    @Param('campaignId', ParseUUIDPipe) campaignId: string,
    @Body() dto: SubmitInvestmentDto,
  ) {
    return this.investments.submit(user.userId, campaignId, dto);
  }

  /** List the caller's own investments. */
  @Get('investments/mine')
  @ResponseMessage('Investments retrieved')
  listMine(@CurrentUser() user: AuthUser) {
    return this.investments.listMine(user.userId);
  }
}
