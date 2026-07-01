import { Module } from '@nestjs/common';
import { TokenHoldingIndexerService } from './token-holding-indexer.service';

/**
 * Ownership tracking: a self-hosted polling loop that keeps `TokenHolding` in sync
 * with on-chain ShareToken balances. Needs no imports — `SorobanModule`,
 * `PrismaModule`, and `CacheModule` are all `@Global`.
 */
@Module({
  providers: [TokenHoldingIndexerService],
})
export class IndexerModule {}
