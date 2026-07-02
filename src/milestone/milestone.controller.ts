import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Role } from '../../generated/prisma/enums';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { ApprovedEntrepreneurGuard } from '../auth/guards/approved-entrepreneur.guard';
import { ApprovedInvestorGuard } from '../auth/guards/approved-investor.guard';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import type { AuthUser } from '../auth/types/auth-user';
import type { UploadedFile as MulterFile } from '../kyc/uploaded-file';
import { CastVoteDto } from './dto/cast-vote.dto';
import { MilestoneVotingService } from './milestone-voting.service';
import { PROOF_MIME_EXT } from './milestone.util';

const MAX_FILE_BYTES = 5 * 1024 * 1024; // 5 MB

/**
 * Milestone voting surface. The entrepreneur submits a milestone for release (with
 * a proof upload); approved investors vote; anyone authenticated can read a campaign's
 * milestones + running tally. The on-chain release is driven asynchronously once a
 * vote settles — no route triggers the chain directly.
 */
@Controller('milestones')
@UseGuards(JwtAuthGuard, RolesGuard)
export class MilestoneController {
  constructor(private readonly voting: MilestoneVotingService) {}

  /** List a campaign's milestones (for the voting UI). `?campaignId=<uuid>`. */
  @Get()
  list(@Query('campaignId', ParseUUIDPipe) campaignId: string) {
    return this.voting.listForCampaign(campaignId);
  }

  /** One milestone: detail + running tally + the caller's own vote. */
  @Get(':milestoneId')
  getOne(
    @CurrentUser() user: AuthUser,
    @Param('milestoneId', ParseUUIDPipe) milestoneId: string,
  ) {
    return this.voting.getDetail(user.userId, milestoneId);
  }

  /** Entrepreneur submits a milestone for release, attaching a proof-of-progress file. */
  @Post(':milestoneId/submit')
  @Roles(Role.ENTREPRENEUR)
  @UseGuards(ApprovedEntrepreneurGuard)
  @UseInterceptors(
    FileInterceptor('proof', { limits: { fileSize: MAX_FILE_BYTES } }),
  )
  submit(
    @CurrentUser() user: AuthUser,
    @Param('milestoneId', ParseUUIDPipe) milestoneId: string,
    @UploadedFile() proof?: MulterFile,
  ) {
    if (!proof) {
      throw new BadRequestException('A proof file is required');
    }
    if (!PROOF_MIME_EXT[proof.mimetype]) {
      throw new BadRequestException('Proof must be a JPEG, PNG, or PDF file');
    }
    return this.voting.submitForRelease(user.userId, milestoneId, proof);
  }

  /** Investor casts (or changes) a weighted ballot on a milestone. */
  @Post(':milestoneId/vote')
  @Roles(Role.INVESTOR)
  @UseGuards(ApprovedInvestorGuard)
  @HttpCode(HttpStatus.OK)
  vote(
    @CurrentUser() user: AuthUser,
    @Param('milestoneId', ParseUUIDPipe) milestoneId: string,
    @Body() dto: CastVoteDto,
  ) {
    return this.voting.vote(user.userId, milestoneId, dto.choice);
  }
}
