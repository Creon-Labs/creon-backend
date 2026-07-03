import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import {
  REFUND_QUEUE,
  RefundJob,
  RefundOrchestratorService,
} from './refund-orchestrator.service';

/**
 * BullMQ worker for the refund queue. Thin: delegates to the idempotent
 * {@link RefundOrchestratorService.drive}. A thrown error fails the job so BullMQ
 * retries it per the configured backoff.
 */
@Processor(REFUND_QUEUE)
export class RefundProcessor extends WorkerHost {
  private readonly logger = new Logger(RefundProcessor.name);

  constructor(private readonly orchestrator: RefundOrchestratorService) {
    super();
  }

  async process(job: Job<RefundJob>): Promise<void> {
    this.logger.log(
      `Processing refund ${job.data.refundId} (attempt ${job.attemptsMade + 1})`,
    );
    await this.orchestrator.drive(job.data.refundId);
  }
}
