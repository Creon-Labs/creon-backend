import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { CampaignModule } from '../campaign/campaign.module';
import { KycModule } from '../kyc/kyc.module';
import { RefundModule } from '../refund/refund.module';
import { AdminController } from './admin.controller';
import { AdminCampaignController } from './admin-campaign.controller';
import { AdminCampaignService } from './admin-campaign.service';
import { AdminProposalController } from './admin-proposal.controller';
import { AdminProposalService } from './admin-proposal.service';
import { AdminService } from './admin.service';

@Module({
  imports: [AuthModule, CampaignModule, KycModule, RefundModule],
  controllers: [
    AdminController,
    AdminProposalController,
    AdminCampaignController,
  ],
  providers: [AdminService, AdminProposalService, AdminCampaignService],
})
export class AdminModule {}
