import {
  Body,
  Controller,
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
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import type { AuthUser } from '../auth/types/auth-user';
import { AdminCampaignService } from './admin-campaign.service';
import { CancelCampaignDto } from './dto/cancel-campaign.dto';

@Controller('admin/campaigns')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.ADMIN)
export class AdminCampaignController {
  constructor(private readonly campaigns: AdminCampaignService) {}

  /** Cancel a problematic campaign → open a pro-rata refund of the remaining custody. */
  @Post(':id/cancel')
  @HttpCode(HttpStatus.OK)
  cancel(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CancelCampaignDto,
    @CurrentUser() admin: AuthUser,
  ) {
    return this.campaigns.cancel(id, admin.userId, dto.reason);
  }
}
