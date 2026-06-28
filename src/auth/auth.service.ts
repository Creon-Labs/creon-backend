import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { Keypair, StrKey } from '@stellar/stellar-base';
import { randomBytes } from 'crypto';
import { CacheService } from '../cache/cache.service';
import { PrismaService } from '../prisma/prisma.service';
import { Role } from '../../generated/prisma/enums';
import { LoginDto } from './dto/login.dto';
import { RegisterDto } from './dto/register.dto';

/**
 * Wallet-based authentication. Ownership of a Stellar address is proven by a
 * challenge–response: the server issues a single-use nonce (stored in Valkey),
 * the client signs it with their secret key, and the server verifies the
 * signature against the public key. A successful verify mints a JWT.
 */
@Injectable()
export class AuthService {
  private readonly challengeTtl: number;

  constructor(
    private readonly cache: CacheService,
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
  ) {
    this.challengeTtl = Number(
      this.config.get<string>('AUTH_CHALLENGE_TTL_SECONDS') ?? '300',
    );
  }

  /** Issue a challenge message for the given wallet to sign. */
  async createChallenge(walletAddress: string): Promise<{ message: string }> {
    this.assertValidAddress(walletAddress);
    const nonce = randomBytes(32).toString('hex');
    const message = [
      'Creon authentication',
      `Wallet: ${walletAddress}`,
      `Nonce: ${nonce}`,
      `Issued: ${new Date().toISOString()}`,
    ].join('\n');
    await this.cache.set(
      this.challengeKey(walletAddress),
      message,
      this.challengeTtl,
    );
    return { message };
  }

  /** Register a new user after verifying wallet ownership. */
  async register(dto: RegisterDto): Promise<{ accessToken: string }> {
    await this.verifySignature(dto.walletAddress, dto.signature);

    const existing = await this.prisma.user.findUnique({
      where: { walletAddress: dto.walletAddress },
    });
    if (existing) {
      throw new ConflictException('Wallet already registered');
    }

    const user = await this.prisma.user.create({
      data: {
        walletAddress: dto.walletAddress,
        roles: [dto.role as Role],
        email: dto.email,
        displayName: dto.displayName,
      },
    });
    return this.signToken(user);
  }

  /** Log in an existing user after verifying wallet ownership. */
  async login(dto: LoginDto): Promise<{ accessToken: string }> {
    await this.verifySignature(dto.walletAddress, dto.signature);

    const user = await this.prisma.user.findUnique({
      where: { walletAddress: dto.walletAddress },
    });
    if (!user) {
      throw new NotFoundException('Wallet not registered');
    }
    return this.signToken(user);
  }

  /**
   * Verify a base64 signature against the wallet's stored challenge. On success
   * the challenge is deleted so it cannot be replayed (single-use).
   */
  private async verifySignature(
    walletAddress: string,
    signatureB64: string,
  ): Promise<void> {
    this.assertValidAddress(walletAddress);
    const key = this.challengeKey(walletAddress);
    const message = await this.cache.get(key);
    if (!message) {
      throw new UnauthorizedException('Challenge missing or expired');
    }

    let valid = false;
    try {
      valid = Keypair.fromPublicKey(walletAddress).verify(
        Buffer.from(message),
        Buffer.from(signatureB64, 'base64'),
      );
    } catch {
      valid = false;
    }
    if (!valid) {
      throw new UnauthorizedException('Invalid signature');
    }

    await this.cache.del(key);
  }

  private signToken(user: { id: string; roles: Role[] }): {
    accessToken: string;
  } {
    const accessToken = this.jwt.sign({ sub: user.id, roles: user.roles });
    return { accessToken };
  }

  private assertValidAddress(walletAddress: string): void {
    if (!StrKey.isValidEd25519PublicKey(walletAddress)) {
      throw new BadRequestException('Invalid Stellar wallet address');
    }
  }

  private challengeKey(walletAddress: string): string {
    return `auth:challenge:${walletAddress}`;
  }
}
