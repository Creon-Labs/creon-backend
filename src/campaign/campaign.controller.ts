import { Controller, Get, Param, ParseUUIDPipe } from '@nestjs/common';
import { ResponseMessage } from '../common/decorators/response-message.decorator';
import { CampaignService } from './campaign.service';

/**
 * Public, unauthenticated browsing of campaigns. Investors need the campaign's
 * on-chain address to prepare an `invest()` tx; anyone can view the marketplace.
 */
@Controller('campaigns')
export class CampaignController {
  constructor(private readonly campaigns: CampaignService) {}

  /** List campaigns whose on-chain contracts are live. */
  @Get()
  @ResponseMessage('Campaigns retrieved')
  list() {
    return this.campaigns.listActive();
  }

  /** Public detail for one campaign. */
  @Get(':id')
  @ResponseMessage('Campaign retrieved')
  get(@Param('id', ParseUUIDPipe) id: string) {
    return this.campaigns.getPublic(id);
  }
}
