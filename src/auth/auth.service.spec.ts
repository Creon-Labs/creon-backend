import {
  BadRequestException,
  ConflictException,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { Keypair } from '@stellar/stellar-base';
import { CacheService } from '../cache/cache.service';
import { PrismaService } from '../prisma/prisma.service';
import { AuthService } from './auth.service';

/** In-memory CacheService stub backed by a Map (TTL ignored). */
function makeCache() {
  const store = new Map<string, string>();
  return {
    store,
    get: jest.fn((k: string) => Promise.resolve(store.get(k) ?? null)),
    set: jest.fn((k: string, v: string) => {
      store.set(k, v);
      return Promise.resolve();
    }),
    del: jest.fn((k: string) => {
      store.delete(k);
      return Promise.resolve();
    }),
  } as unknown as CacheService & { store: Map<string, string> };
}

function makePrisma() {
  return {
    user: {
      findUnique: jest.fn(),
      create: jest.fn(),
    },
  } as unknown as PrismaService & {
    user: { findUnique: jest.Mock; create: jest.Mock };
  };
}

const config = {
  get: (k: string) => (k === 'AUTH_CHALLENGE_TTL_SECONDS' ? '300' : undefined),
} as unknown as ConfigService;

const jwt = {
  sign: jest.fn(() => 'signed.jwt.token'),
} as unknown as JwtService;

/** Sign the message currently stored for `wallet` and return base64 signature. */
function signStoredMessage(
  cache: CacheService & { store: Map<string, string> },
  keypair: Keypair,
): string {
  const message = cache.store.get(`auth:challenge:${keypair.publicKey()}`)!;
  return keypair.sign(Buffer.from(message)).toString('base64');
}

describe('AuthService', () => {
  let keypair: Keypair;
  let cache: ReturnType<typeof makeCache>;
  let prisma: ReturnType<typeof makePrisma>;
  let service: AuthService;

  beforeEach(() => {
    keypair = Keypair.random();
    cache = makeCache();
    prisma = makePrisma();
    service = new AuthService(cache, prisma, jwt, config);
  });

  it('rejects an invalid wallet address on challenge', async () => {
    await expect(service.createChallenge('not-a-key')).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('stores a challenge keyed by wallet', async () => {
    const { message } = await service.createChallenge(keypair.publicKey());
    expect(message).toContain(keypair.publicKey());
    expect(cache.store.has(`auth:challenge:${keypair.publicKey()}`)).toBe(true);
  });

  it('registers a new entrepreneur with a valid signature', async () => {
    await service.createChallenge(keypair.publicKey());
    prisma.user.findUnique.mockResolvedValue(null);
    prisma.user.create.mockResolvedValue({
      id: 'u1',
      roles: ['ENTREPRENEUR'],
    });

    const result = await service.register({
      walletAddress: keypair.publicKey(),
      signature: signStoredMessage(cache, keypair),
      role: 'ENTREPRENEUR',
      email: 'e@example.com',
    });

    expect(result).toEqual({ accessToken: 'signed.jwt.token' });
    expect(prisma.user.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        walletAddress: keypair.publicKey(),
        roles: ['ENTREPRENEUR'],
        email: 'e@example.com',
      }) as unknown,
    });
    // challenge consumed
    expect(cache.store.has(`auth:challenge:${keypair.publicKey()}`)).toBe(
      false,
    );
  });

  it('rejects registration when the wallet already exists', async () => {
    await service.createChallenge(keypair.publicKey());
    prisma.user.findUnique.mockResolvedValue({ id: 'u1' });

    await expect(
      service.register({
        walletAddress: keypair.publicKey(),
        signature: signStoredMessage(cache, keypair),
        role: 'INVESTOR',
      }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('rejects a bad signature', async () => {
    await service.createChallenge(keypair.publicKey());
    const otherSig = Keypair.random()
      .sign(Buffer.from('something else'))
      .toString('base64');

    await expect(
      service.login({
        walletAddress: keypair.publicKey(),
        signature: otherSig,
      }),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('rejects when no challenge exists (missing/expired)', async () => {
    await expect(
      service.login({
        walletAddress: keypair.publicKey(),
        signature: 'AAAA',
      }),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('is single-use: a consumed challenge cannot be replayed', async () => {
    await service.createChallenge(keypair.publicKey());
    prisma.user.findUnique.mockResolvedValue({ id: 'u1', roles: ['INVESTOR'] });
    const signature = signStoredMessage(cache, keypair);

    await service.login({ walletAddress: keypair.publicKey(), signature });

    await expect(
      service.login({ walletAddress: keypair.publicKey(), signature }),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('rejects login for an unregistered wallet', async () => {
    await service.createChallenge(keypair.publicKey());
    prisma.user.findUnique.mockResolvedValue(null);

    await expect(
      service.login({
        walletAddress: keypair.publicKey(),
        signature: signStoredMessage(cache, keypair),
      }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});
