import { Module } from '@nestjs/common';
import { FaucetController } from './faucet.controller';
import { FaucetService } from './faucet.service';

/**
 * Public test-USDC faucet. `CacheModule` is global, so no explicit import is
 * needed for `CacheService`.
 */
@Module({
  controllers: [FaucetController],
  providers: [FaucetService],
})
export class FaucetModule {}
