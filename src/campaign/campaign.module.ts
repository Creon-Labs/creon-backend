import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { CampaignDeployProcessor } from './campaign-deploy.processor';
import {
  CAMPAIGN_DEPLOY_QUEUE,
  CampaignDeployService,
} from './campaign-deploy.service';
import { CampaignService } from './campaign.service';

/**
 * Owns the off-chain Campaign mirror + its on-chain deploy orchestration.
 * Registers the BullMQ deploy queue (connection configured globally in
 * `app.module`). Exports the services so `AdminModule` can create a campaign on
 * approval and enqueue its deploy.
 */
@Module({
  imports: [BullModule.registerQueue({ name: CAMPAIGN_DEPLOY_QUEUE })],
  providers: [CampaignService, CampaignDeployService, CampaignDeployProcessor],
  exports: [CampaignService, CampaignDeployService],
})
export class CampaignModule {}
