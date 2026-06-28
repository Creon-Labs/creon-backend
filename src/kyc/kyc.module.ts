import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { KycController } from './kyc.controller';
import { KycService } from './kyc.service';

@Module({
  imports: [AuthModule],
  controllers: [KycController],
  providers: [KycService],
})
export class KycModule {}
