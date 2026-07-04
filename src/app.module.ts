import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { APP_FILTER, APP_INTERCEPTOR } from '@nestjs/core';
import { ScheduleModule } from '@nestjs/schedule';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { HttpExceptionFilter } from './common/filters/http-exception.filter';
import { ResponseEnvelopeInterceptor } from './common/interceptors/response-envelope.interceptor';
import { PrismaModule } from './prisma/prisma.module';
import { StorageModule } from './storage/storage.module';
import { CacheModule } from './cache/cache.module';
import { AuthModule } from './auth/auth.module';
import { KycModule } from './kyc/kyc.module';
import { AdminModule } from './admin/admin.module';
import { ProposalModule } from './proposal/proposal.module';
import { SorobanModule } from './soroban/soroban.module';
import { CampaignModule } from './campaign/campaign.module';
import { InvestmentModule } from './investment/investment.module';
import { IndexerModule } from './indexer/indexer.module';
import { HoldingModule } from './holding/holding.module';
import { DistributionModule } from './distribution/distribution.module';
import { MilestoneModule } from './milestone/milestone.module';
import { RefundModule } from './refund/refund.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    ScheduleModule.forRoot(),
    // BullMQ runs on the same Valkey instance as the cache (Redis-compatible).
    BullModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        connection: {
          host: config.getOrThrow<string>('VALKEY_HOST'),
          port: Number(config.get<string>('VALKEY_PORT') ?? '6379'),
          password: config.get<string>('VALKEY_PASSWORD') || undefined,
          tls: config.get<string>('VALKEY_USE_TLS') === 'true' ? {} : undefined,
          // Required by BullMQ for its blocking worker connections.
          maxRetriesPerRequest: null,
        },
        // Shared retry/backoff policy for every queue; a producer may still
        // override per `.add()`.
        defaultJobOptions: {
          attempts: 5,
          backoff: { type: 'exponential', delay: 5000 },
          removeOnComplete: true,
        },
      }),
    }),
    PrismaModule,
    StorageModule,
    CacheModule,
    SorobanModule,
    AuthModule,
    KycModule,
    AdminModule,
    ProposalModule,
    CampaignModule,
    InvestmentModule,
    IndexerModule,
    HoldingModule,
    DistributionModule,
    MilestoneModule,
    RefundModule,
  ],
  controllers: [AppController],
  providers: [
    AppService,
    { provide: APP_INTERCEPTOR, useClass: ResponseEnvelopeInterceptor },
    { provide: APP_FILTER, useClass: HttpExceptionFilter },
  ],
})
export class AppModule {}
