import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import {
  REFUND_QUEUE,
  RefundOrchestratorService,
} from './refund-orchestrator.service';
import { RefundController } from './refund.controller';
import { RefundProcessor } from './refund.processor';
import { RefundService } from './refund.service';

/**
 * Campaign refunds: the investor claim relay and the BullMQ orchestrator that freezes
 * a cancelled campaign (`cancel()`), snapshots holdings, splits the remaining custody
 * pro-rata, and posts the refund Merkle root on-chain (`set_refund`). The admin cancel
 * that opens a refund lives in {@link AdminModule}, which imports the orchestrator to
 * enqueue after commit. Imports {@link AuthModule} for the JWT / role / approved-user
 * guards; `SorobanModule`, `PrismaModule`, and `CacheModule` are global. Registers the
 * BullMQ refund queue (connection configured globally in `app.module`).
 */
@Module({
  imports: [AuthModule, BullModule.registerQueue({ name: REFUND_QUEUE })],
  controllers: [RefundController],
  providers: [RefundService, RefundOrchestratorService, RefundProcessor],
  exports: [RefundService, RefundOrchestratorService],
})
export class RefundModule {}
