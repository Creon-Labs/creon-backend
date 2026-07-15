import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { InvestmentController } from './investment.controller';
import { InvestmentService } from './investment.service';
import { CampaignModule } from '../campaign/campaign.module';

/**
 * The investor-facing investment flow. Imports {@link AuthModule} for the JWT /
 * role / approved-investor guards; `SorobanModule` and `PrismaModule` are global.
 */
@Module({
  imports: [AuthModule, CampaignModule],
  controllers: [InvestmentController],
  providers: [InvestmentService],
})
export class InvestmentModule {}
