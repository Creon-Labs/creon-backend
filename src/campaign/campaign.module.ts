import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { CampaignDeployProcessor } from './campaign-deploy.processor';
import {
  CAMPAIGN_DEPLOY_QUEUE,
  CampaignDeployService,
} from './campaign-deploy.service';
import { CampaignUnlockProcessor } from './campaign-unlock.processor';
import {
  CAMPAIGN_UNLOCK_QUEUE,
  CampaignUnlockService,
} from './campaign-unlock.service';
import { CampaignController } from './campaign.controller';
import { CampaignService } from './campaign.service';
import { RefundModule } from '../refund/refund.module';
import { CampaignFundingCloseProcessor } from './campaign-funding-close.processor';
import {
  CAMPAIGN_FUNDING_CLOSE_QUEUE,
  CampaignFundingCloseService,
} from './campaign-funding-close.service';

/**
 * Owns the off-chain Campaign mirror + its on-chain deploy orchestration + the
 * automatic post-lock unlock trigger. Registers the BullMQ deploy + unlock queues
 * (connection configured globally in `app.module`). Exports the services so
 * `AdminModule` can create a campaign on approval and enqueue its deploy.
 */
@Module({
  imports: [
    RefundModule,
    BullModule.registerQueue(
      { name: CAMPAIGN_DEPLOY_QUEUE },
      { name: CAMPAIGN_UNLOCK_QUEUE },
      { name: CAMPAIGN_FUNDING_CLOSE_QUEUE },
    ),
  ],
  controllers: [CampaignController],
  providers: [
    CampaignService,
    CampaignDeployService,
    CampaignDeployProcessor,
    CampaignUnlockService,
    CampaignUnlockProcessor,
    CampaignFundingCloseService,
    CampaignFundingCloseProcessor,
  ],
  exports: [
    CampaignService,
    CampaignDeployService,
    CampaignUnlockService,
    CampaignFundingCloseService,
  ],
})
export class CampaignModule {}
