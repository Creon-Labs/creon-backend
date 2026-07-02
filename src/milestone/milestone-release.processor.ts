import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import {
  MILESTONE_RELEASE_QUEUE,
  MilestoneReleaseJob,
  MilestoneReleaseService,
} from './milestone-release.service';

/**
 * BullMQ worker for the milestone-release queue. Thin: delegates to the idempotent
 * {@link MilestoneReleaseService.drive}. A thrown error fails the job so BullMQ
 * retries it per the configured backoff.
 */
@Processor(MILESTONE_RELEASE_QUEUE)
export class MilestoneReleaseProcessor extends WorkerHost {
  private readonly logger = new Logger(MilestoneReleaseProcessor.name);

  constructor(private readonly orchestrator: MilestoneReleaseService) {
    super();
  }

  async process(job: Job<MilestoneReleaseJob>): Promise<void> {
    this.logger.log(
      `Processing milestone release ${job.data.milestoneId} (attempt ${job.attemptsMade + 1})`,
    );
    await this.orchestrator.drive(job.data.milestoneId);
  }
}
