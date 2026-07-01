import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import {
  DISTRIBUTION_QUEUE,
  DistributionJob,
  DistributionOrchestratorService,
} from './distribution-orchestrator.service';

/**
 * BullMQ worker for the distribution queue. Thin: delegates to the idempotent
 * {@link DistributionOrchestratorService.drive}. A thrown error fails the job so
 * BullMQ retries it per the configured backoff.
 */
@Processor(DISTRIBUTION_QUEUE)
export class DistributionProcessor extends WorkerHost {
  private readonly logger = new Logger(DistributionProcessor.name);

  constructor(private readonly orchestrator: DistributionOrchestratorService) {
    super();
  }

  async process(job: Job<DistributionJob>): Promise<void> {
    this.logger.log(
      `Processing distribution ${job.data.distributionId} (attempt ${job.attemptsMade + 1})`,
    );
    await this.orchestrator.drive(job.data.distributionId);
  }
}
