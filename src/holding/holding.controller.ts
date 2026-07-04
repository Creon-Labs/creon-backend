import {
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  UseGuards,
} from '@nestjs/common';
import { Role } from '../../generated/prisma/enums';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import type { AuthUser } from '../auth/types/auth-user';
import { ResponseMessage } from '../common/decorators/response-message.decorator';
import { HoldingService } from './holding.service';

/**
 * Read surface for share ownership. `/holdings/mine` is the investor's own portfolio
 * (auth required); `/campaigns/:id/holdings` is a public, identity-masked cap table.
 */
@Controller()
export class HoldingController {
  constructor(private readonly holdings: HoldingService) {}

  /** The authenticated investor's own current holdings. */
  @Get('holdings/mine')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.INVESTOR)
  @ResponseMessage('Holdings retrieved')
  listMine(@CurrentUser() user: AuthUser) {
    return this.holdings.listMine(user.userId);
  }

  /** Public cap table for one campaign (holder identity masked). */
  @Get('campaigns/:id/holdings')
  @ResponseMessage('Campaign holdings retrieved')
  listForCampaign(@Param('id', ParseUUIDPipe) id: string) {
    return this.holdings.listForCampaign(id);
  }
}
