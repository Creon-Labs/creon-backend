import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { KycController } from './kyc.controller';
import { KycWhitelistProcessor } from './kyc-whitelist.processor';
import {
  KYC_WHITELIST_QUEUE,
  KycWhitelistService,
} from './kyc-whitelist.service';
import { KycService } from './kyc.service';

/**
 * Owns KYC submission + its on-chain ComplianceRegistry whitelist sync. Registers
 * the BullMQ whitelist queue (connection configured globally in `app.module`) and
 * exports {@link KycWhitelistService} so `AdminModule` can enqueue a sync on
 * approve/revoke.
 */
@Module({
  imports: [
    AuthModule,
    BullModule.registerQueue({ name: KYC_WHITELIST_QUEUE }),
  ],
  controllers: [KycController],
  providers: [KycService, KycWhitelistService, KycWhitelistProcessor],
  exports: [KycWhitelistService],
})
export class KycModule {}
