import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import {
  CAMPAIGN_DEPLOY_QUEUE,
  CampaignDeployJob,
  CampaignDeployService,
} from './campaign-deploy.service';

/**
 * BullMQ worker for the campaign-deploy queue. Thin: delegates to the idempotent
 * {@link CampaignDeployService.drive}. A thrown error fails the job so BullMQ
 * retries it per the configured backoff.
 */
@Processor(CAMPAIGN_DEPLOY_QUEUE)
export class CampaignDeployProcessor extends WorkerHost {
  private readonly logger = new Logger(CampaignDeployProcessor.name);

  constructor(private readonly deployService: CampaignDeployService) {
    super();
  }

  async process(job: Job<CampaignDeployJob>): Promise<void> {
    this.logger.log(
      `Processing deploy for campaign ${job.data.campaignId} (attempt ${job.attemptsMade + 1})`,
    );
    await this.deployService.drive(job.data.campaignId);
  }
}
