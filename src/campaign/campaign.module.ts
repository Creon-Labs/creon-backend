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

/**
 * Owns the off-chain Campaign mirror + its on-chain deploy orchestration + the
 * automatic post-lock unlock trigger. Registers the BullMQ deploy + unlock queues
 * (connection configured globally in `app.module`). Exports the services so
 * `AdminModule` can create a campaign on approval and enqueue its deploy.
 */
@Module({
  imports: [
    BullModule.registerQueue(
      { name: CAMPAIGN_DEPLOY_QUEUE },
      { name: CAMPAIGN_UNLOCK_QUEUE },
    ),
  ],
  controllers: [CampaignController],
  providers: [
    CampaignService,
    CampaignDeployService,
    CampaignDeployProcessor,
    CampaignUnlockService,
    CampaignUnlockProcessor,
  ],
  exports: [CampaignService, CampaignDeployService, CampaignUnlockService],
})
export class CampaignModule {}
