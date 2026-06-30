import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { PrismaModule } from './prisma/prisma.module';
import { StorageModule } from './storage/storage.module';
import { CacheModule } from './cache/cache.module';
import { AuthModule } from './auth/auth.module';
import { KycModule } from './kyc/kyc.module';
import { AdminModule } from './admin/admin.module';
import { ProposalModule } from './proposal/proposal.module';
import { SorobanModule } from './soroban/soroban.module';
import { CampaignModule } from './campaign/campaign.module';

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
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
