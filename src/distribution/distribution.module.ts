import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { DistributionController } from './distribution.controller';
import {
  DISTRIBUTION_QUEUE,
  DistributionOrchestratorService,
} from './distribution-orchestrator.service';
import { DistributionProcessor } from './distribution.processor';
import { DistributionService } from './distribution.service';

/**
 * Dividend distribution (Phase 6): the entrepreneur deposit relay, the investor
 * claim relay, and the BullMQ orchestrator that snapshots holdings, builds the
 * Merkle tree, and posts the root on-chain. Imports {@link AuthModule} for the JWT /
 * role / approved-user guards; `SorobanModule`, `PrismaModule`, and `CacheModule`
 * are global. Registers the BullMQ distribution queue (connection configured
 * globally in `app.module`).
 */
@Module({
  imports: [AuthModule, BullModule.registerQueue({ name: DISTRIBUTION_QUEUE })],
  controllers: [DistributionController],
  providers: [
    DistributionService,
    DistributionOrchestratorService,
    DistributionProcessor,
  ],
  exports: [DistributionService, DistributionOrchestratorService],
})
export class DistributionModule {}
