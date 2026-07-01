import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtModule, JwtSignOptions } from '@nestjs/jwt';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import { RolesGuard } from './guards/roles.guard';
import { ApprovedEntrepreneurGuard } from './guards/approved-entrepreneur.guard';
import { ApprovedInvestorGuard } from './guards/approved-investor.guard';

@Module({
  imports: [
    JwtModule.registerAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        secret: config.getOrThrow<string>('JWT_SECRET'),
        signOptions: {
          expiresIn: (config.get<string>('JWT_EXPIRES_IN') ??
            '7d') as JwtSignOptions['expiresIn'],
        },
      }),
    }),
  ],
  controllers: [AuthController],
  providers: [
    AuthService,
    JwtAuthGuard,
    RolesGuard,
    ApprovedEntrepreneurGuard,
    ApprovedInvestorGuard,
  ],
  // Re-export JwtModule so importers of AuthModule get JwtService for the guards.
  exports: [
    AuthService,
    JwtAuthGuard,
    RolesGuard,
    ApprovedEntrepreneurGuard,
    ApprovedInvestorGuard,
    JwtModule,
  ],
})
export class AuthModule {}
