import { Global, Module } from '@nestjs/common';
import { SorobanService } from './soroban.service';

/** Global so any module can inject {@link SorobanService} without re-importing. */
@Global()
@Module({
  providers: [SorobanService],
  exports: [SorobanService],
})
export class SorobanModule {}
