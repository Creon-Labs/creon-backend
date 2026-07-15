import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import {
  CAMPAIGN_FUNDING_CLOSE_QUEUE,
  CampaignFundingCloseJob,
  CampaignFundingCloseService,
} from './campaign-funding-close.service';

@Processor(CAMPAIGN_FUNDING_CLOSE_QUEUE)
export class CampaignFundingCloseProcessor extends WorkerHost {
  constructor(private readonly fundingClose: CampaignFundingCloseService) {
    super();
  }
  process(job: Job<CampaignFundingCloseJob>): Promise<void> {
    return this.fundingClose.drive(job.data.campaignId);
  }
}
