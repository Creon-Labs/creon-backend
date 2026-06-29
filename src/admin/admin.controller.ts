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
import { KycStatus, Role } from '../../generated/prisma/enums';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import type { AuthUser } from '../auth/types/auth-user';
import { AdminService } from './admin.service';
import { RejectKycDto } from './dto/reject-kyc.dto';

@Controller('admin/kyc')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.ADMIN)
export class AdminController {
  constructor(private readonly admin: AdminService) {}

  /** List KYC submissions for review; defaults to PENDING. */
  @Get()
  list(@Query('status') status?: string) {
    const resolved = status ?? KycStatus.PENDING;
    if (!Object.values(KycStatus).includes(resolved as KycStatus)) {
      throw new BadRequestException('Invalid status');
    }
    return this.admin.list(resolved as KycStatus);
  }

  @Post(':userId/approve')
  @HttpCode(HttpStatus.OK)
  approve(
    @Param('userId', ParseUUIDPipe) userId: string,
    @CurrentUser() admin: AuthUser,
  ) {
    return this.admin.approve(userId, admin.userId);
  }

  @Post(':userId/reject')
  @HttpCode(HttpStatus.OK)
  reject(
    @Param('userId', ParseUUIDPipe) userId: string,
    @Body() dto: RejectKycDto,
    @CurrentUser() admin: AuthUser,
  ) {
    return this.admin.reject(userId, admin.userId, dto.reason);
  }
}
