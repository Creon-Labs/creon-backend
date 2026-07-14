import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  UploadedFiles,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileFieldsInterceptor } from '@nestjs/platform-express';
import { Role } from '../../generated/prisma/enums';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { ApprovedEntrepreneurGuard } from '../auth/guards/approved-entrepreneur.guard';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import type { AuthUser } from '../auth/types/auth-user';
import { ResponseMessage } from '../common/decorators/response-message.decorator';
import type { UploadedFile } from '../kyc/uploaded-file';
import { CreateProposalDto } from './dto/create-proposal.dto';
import { UpdateProposalDto } from './dto/update-proposal.dto';
import {
  DOCUMENT_MIME_EXT,
  IMAGE_MIME_EXT,
  MAX_DOCUMENTS,
  MAX_FILE_BYTES,
  MAX_IMAGES,
} from './proposal-media.util';
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

  /**
   * Upload gallery images and/or PDF documents while the proposal is DRAFT.
   * Field names: `images` (JPEG/PNG/WebP, max 5), `documents` (PDF, max 3).
   */
  @Post(':id/media')
  @UseGuards(ApprovedEntrepreneurGuard)
  @UseInterceptors(
    FileFieldsInterceptor(
      [
        { name: 'images', maxCount: MAX_IMAGES },
        { name: 'documents', maxCount: MAX_DOCUMENTS },
      ],
      { limits: { fileSize: MAX_FILE_BYTES } },
    ),
  )
  @ResponseMessage('Media uploaded')
  addMedia(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @UploadedFiles()
    files?: { images?: UploadedFile[]; documents?: UploadedFile[] },
  ) {
    const images = files?.images ?? [];
    const documents = files?.documents ?? [];
    if (images.length === 0 && documents.length === 0) {
      throw new BadRequestException(
        'At least one image or document file is required',
      );
    }
    for (const file of images) {
      if (!IMAGE_MIME_EXT[file.mimetype]) {
        throw new BadRequestException(
          'Images must be JPEG, PNG, or WebP',
        );
      }
    }
    for (const file of documents) {
      if (!DOCUMENT_MIME_EXT[file.mimetype]) {
        throw new BadRequestException('Documents must be PDF files');
      }
    }
    return this.proposals.addMedia(user.userId, id, images, documents);
  }

  /** Remove one media item while the proposal is DRAFT. */
  @Delete(':id/media/:mediaId')
  @UseGuards(ApprovedEntrepreneurGuard)
  @ResponseMessage('Media removed')
  removeMedia(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('mediaId', ParseUUIDPipe) mediaId: string,
  ) {
    return this.proposals.removeMedia(user.userId, id, mediaId);
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
