import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import {
  KYC_WHITELIST_QUEUE,
  KycWhitelistJob,
  KycWhitelistService,
} from './kyc-whitelist.service';

/**
 * BullMQ worker for the kyc-whitelist queue. Thin: delegates to the idempotent
 * {@link KycWhitelistService.drive}. A thrown error fails the job so BullMQ
 * retries it per the configured backoff.
 */
@Processor(KYC_WHITELIST_QUEUE)
export class KycWhitelistProcessor extends WorkerHost {
  private readonly logger = new Logger(KycWhitelistProcessor.name);

  constructor(private readonly whitelist: KycWhitelistService) {
    super();
  }

  async process(job: Job<KycWhitelistJob>): Promise<void> {
    this.logger.log(
      `Processing whitelist sync for user ${job.data.userId} (attempt ${job.attemptsMade + 1})`,
    );
    await this.whitelist.drive(job.data.userId);
  }
}
