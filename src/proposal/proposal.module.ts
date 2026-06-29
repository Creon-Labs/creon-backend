import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { ProposalController } from './proposal.controller';
import { ProposalService } from './proposal.service';

@Module({
  imports: [AuthModule],
  controllers: [ProposalController],
  providers: [ProposalService],
})
export class ProposalModule {}
