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
  UseGuards,
} from '@nestjs/common';
import { ProposalStatus, Role } from '../../generated/prisma/enums';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import type { AuthUser } from '../auth/types/auth-user';
import { ResponseMessage } from '../common/decorators/response-message.decorator';
import { AdminProposalService } from './admin-proposal.service';
import { RejectProposalDto } from './dto/reject-proposal.dto';

@Controller('admin/proposals')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.ADMIN)
export class AdminProposalController {
  constructor(private readonly proposals: AdminProposalService) {}

  /** List proposals for review; defaults to SUBMITTED. */
  @Get()
  @ResponseMessage('Proposals retrieved')
  list(@Query('status') status?: string) {
    const resolved = status ?? ProposalStatus.SUBMITTED;
    if (!Object.values(ProposalStatus).includes(resolved as ProposalStatus)) {
      throw new BadRequestException('Invalid status');
    }
    return this.proposals.list(resolved as ProposalStatus);
  }

  /** Approve a proposal → create its campaign + enqueue the on-chain deploy. */
  @Post(':id/approve')
  @HttpCode(HttpStatus.OK)
  @ResponseMessage('Proposal approved')
  approve(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() admin: AuthUser,
  ) {
    return this.proposals.approve(id, admin.userId);
  }

  /** Reject a proposal with a reason. */
  @Post(':id/reject')
  @HttpCode(HttpStatus.OK)
  @ResponseMessage('Proposal rejected')
  reject(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: RejectProposalDto,
    @CurrentUser() admin: AuthUser,
  ) {
    return this.proposals.reject(id, admin.userId, dto.reason);
  }
}
