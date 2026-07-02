import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { MilestoneController } from './milestone.controller';
import {
  MILESTONE_RELEASE_QUEUE,
  MilestoneReleaseService,
} from './milestone-release.service';
import { MilestoneReleaseProcessor } from './milestone-release.processor';
import { MilestoneVotingService } from './milestone-voting.service';

/**
 * Milestone-based fund release: off-chain investor voting (Postgres) plus the BullMQ
 * orchestrator that calls `release_milestone` on-chain once a vote settles. Imports
 * {@link AuthModule} for the JWT / role / approved-user guards; `SorobanModule`,
 * `PrismaModule`, `StorageModule`, and `CacheModule` are global. Registers the BullMQ
 * milestone-release queue (connection configured globally in `app.module`).
 */
@Module({
  imports: [
    AuthModule,
    BullModule.registerQueue({ name: MILESTONE_RELEASE_QUEUE }),
  ],
  controllers: [MilestoneController],
  providers: [
    MilestoneVotingService,
    MilestoneReleaseService,
    MilestoneReleaseProcessor,
  ],
  exports: [MilestoneVotingService, MilestoneReleaseService],
})
export class MilestoneModule {}
