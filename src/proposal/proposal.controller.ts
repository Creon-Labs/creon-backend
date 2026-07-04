import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { Role } from '../../generated/prisma/enums';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { ApprovedEntrepreneurGuard } from '../auth/guards/approved-entrepreneur.guard';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import type { AuthUser } from '../auth/types/auth-user';
import { ResponseMessage } from '../common/decorators/response-message.decorator';
import { CreateProposalDto } from './dto/create-proposal.dto';
import { UpdateProposalDto } from './dto/update-proposal.dto';
import { ProposalService } from './proposal.service';

@Controller('proposals')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.ENTREPRENEUR)
export class ProposalController {
  constructor(private readonly proposals: ProposalService) {}

  /** Create a funding proposal (off-chain) as a DRAFT. Requires approved KYC. */
  @Post()
  @UseGuards(ApprovedEntrepreneurGuard)
  @ResponseMessage('Proposal created')
  create(@CurrentUser() user: AuthUser, @Body() dto: CreateProposalDto) {
    return this.proposals.create(user.userId, dto);
  }

  /** List the caller's own proposals. */
  @Get()
  @ResponseMessage('Proposals retrieved')
  list(@CurrentUser() user: AuthUser) {
    return this.proposals.listMine(user.userId);
  }

  /** Get one of the caller's own proposals. */
  @Get(':id')
  @ResponseMessage('Proposal retrieved')
  get(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.proposals.getMine(user.userId, id);
  }

  /** Edit a proposal while it is still a DRAFT. Requires approved KYC. */
  @Patch(':id')
  @UseGuards(ApprovedEntrepreneurGuard)
  @ResponseMessage('Proposal updated')
  update(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateProposalDto,
  ) {
    return this.proposals.update(user.userId, id, dto);
  }

  /** Submit a DRAFT proposal for admin review (DRAFT -> SUBMITTED). */
  @Post(':id/submit')
  @HttpCode(HttpStatus.OK)
  @UseGuards(ApprovedEntrepreneurGuard)
  @ResponseMessage('Proposal submitted')
  submit(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.proposals.submit(user.userId, id);
  }
}
