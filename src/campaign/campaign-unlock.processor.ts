import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import {
  CAMPAIGN_UNLOCK_QUEUE,
  CampaignUnlockJob,
  CampaignUnlockService,
} from './campaign-unlock.service';

/**
 * BullMQ worker for the campaign-unlock queue. Thin: delegates to the idempotent
 * {@link CampaignUnlockService.drive}. A thrown error fails the job so BullMQ
 * retries it per the configured backoff.
 */
@Processor(CAMPAIGN_UNLOCK_QUEUE)
export class CampaignUnlockProcessor extends WorkerHost {
  private readonly logger = new Logger(CampaignUnlockProcessor.name);

  constructor(private readonly unlockService: CampaignUnlockService) {
    super();
  }

  async process(job: Job<CampaignUnlockJob>): Promise<void> {
    this.logger.log(
      `Processing unlock for campaign ${job.data.campaignId} (attempt ${job.attemptsMade + 1})`,
    );
    await this.unlockService.drive(job.data.campaignId);
  }
}
