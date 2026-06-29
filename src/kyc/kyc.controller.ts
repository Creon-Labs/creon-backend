import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Post,
  UploadedFiles,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileFieldsInterceptor } from '@nestjs/platform-express';
import { KycStatus, Role } from '../../generated/prisma/enums';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import type { AuthUser } from '../auth/types/auth-user';
import { SubmitKycDto } from './dto/submit-kyc.dto';
import { KycService } from './kyc.service';
import { UploadedFile } from './uploaded-file';

const MAX_FILE_BYTES = 5 * 1024 * 1024; // 5 MB
const ALLOWED_MIME = ['image/jpeg', 'image/png'];

@Controller('kyc')
@UseGuards(JwtAuthGuard, RolesGuard)
export class KycController {
  constructor(private readonly kyc: KycService) {}

  /** Submit KYC: identity fields + KTP/ID card and selfie images (both required). */
  @Post()
  @Roles(Role.ENTREPRENEUR, Role.INVESTOR)
  @UseInterceptors(
    FileFieldsInterceptor(
      [
        { name: 'idCard', maxCount: 1 },
        { name: 'selfie', maxCount: 1 },
      ],
      { limits: { fileSize: MAX_FILE_BYTES } },
    ),
  )
  submit(
    @CurrentUser() user: AuthUser,
    @Body() dto: SubmitKycDto,
    @UploadedFiles()
    files: { idCard?: UploadedFile[]; selfie?: UploadedFile[] },
  ): Promise<{ status: KycStatus; submittedAt: Date }> {
    const idCard = files?.idCard?.[0];
    const selfie = files?.selfie?.[0];
    if (!idCard || !selfie) {
      throw new BadRequestException(
        'Both idCard and selfie files are required',
      );
    }
    for (const file of [idCard, selfie]) {
      if (!ALLOWED_MIME.includes(file.mimetype)) {
        throw new BadRequestException('Only JPEG and PNG images are allowed');
      }
    }
    return this.kyc.submit(user.userId, dto, idCard, selfie);
  }

  /** The caller's own KYC status. */
  @Get('me')
  @Roles(Role.ENTREPRENEUR, Role.INVESTOR)
  getMine(@CurrentUser() user: AuthUser) {
    return this.kyc.getMine(user.userId);
  }
}
