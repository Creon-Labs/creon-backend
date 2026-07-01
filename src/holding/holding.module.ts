import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { HoldingController } from './holding.controller';
import { HoldingService } from './holding.service';

/**
 * The read surface over `TokenHolding` (written by the ownership indexer). Imports
 * {@link AuthModule} for the JWT / role guards on `/holdings/mine`; `PrismaModule`
 * is global.
 */
@Module({
  imports: [AuthModule],
  controllers: [HoldingController],
  providers: [HoldingService],
})
export class HoldingModule {}
