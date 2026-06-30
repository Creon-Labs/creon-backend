import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { CampaignModule } from '../campaign/campaign.module';
import { KycModule } from '../kyc/kyc.module';
import { AdminController } from './admin.controller';
import { AdminProposalController } from './admin-proposal.controller';
import { AdminProposalService } from './admin-proposal.service';
import { AdminService } from './admin.service';

@Module({
  imports: [AuthModule, CampaignModule, KycModule],
  controllers: [AdminController, AdminProposalController],
  providers: [AdminService, AdminProposalService],
})
export class AdminModule {}
