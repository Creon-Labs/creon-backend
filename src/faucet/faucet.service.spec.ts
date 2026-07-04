import { BadRequestException, ConflictException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  Asset,
  Keypair,
  Operation,
  TransactionBuilder,
} from '@stellar/stellar-sdk';
import { CacheService } from '../cache/cache.service';
import { FaucetService } from './faucet.service';

const PASSPHRASE = 'Test SDF Network ; September 2015';

/** Minimal duck-typed account satisfying what `TransactionBuilder` needs. */
function fakeAccount(publicKey: string, balances: unknown[] = []) {
  let seq = 100;
  return {
    accountId: () => publicKey,
    sequenceNumber: () => String(seq),
    incrementSequenceNumber: () => {
      seq += 1;
    },
    balances,
  };
}

function usdcBalance(issuer: string) {
  return {
    asset_type: 'credit_alphanum4',
    asset_code: 'USDC',
    asset_issuer: issuer,
  };
}

function makeCache(overrides: Partial<CacheService> = {}): CacheService {
  return {
    get: jest.fn().mockResolvedValue(null),
    set: jest.fn().mockResolvedValue(undefined),
    del: jest.fn(),
    getJson: jest.fn(),
    setJson: jest.fn(),
    ...overrides,
  } as unknown as CacheService;
}

function makeService(cache: CacheService, platformSecret: string) {
  const config = {
    getOrThrow: (k: string) => {
      const map: Record<string, string | undefined> = {
        STELLAR_HORIZON_URL: 'https://horizon-testnet.stellar.org',
        STELLAR_NETWORK_PASSPHRASE: PASSPHRASE,
        STELLAR_PLATFORM_SECRET: platformSecret,
      };
      const v = map[k];
      if (v === undefined) throw new Error(`missing ${k}`);
      return v;
    },
    get: (k: string) => {
      const map: Record<string, string | undefined> = {
        FAUCET_USDC_AMOUNT: '1000',
        FAUCET_CLAIM_COOLDOWN_SECONDS: '86400',
      };
      return map[k];
    },
  } as unknown as ConfigService;
  return new FaucetService(config, cache);
}

describe('FaucetService', () => {
  const platform = Keypair.random();
  const wallet = Keypair.random();

  describe('prepareTrustline', () => {
    it('returns an unsigned changeTrust xdr when no trustline exists', async () => {
      const service = makeService(makeCache(), platform.secret());
      const server = (
        service as unknown as { server: { loadAccount: jest.Mock } }
      ).server;
      server.loadAccount = jest
        .fn()
        .mockResolvedValue(fakeAccount(wallet.publicKey(), []));

      const { xdr } = await service.prepareTrustline(wallet.publicKey());
      const tx = TransactionBuilder.fromXDR(xdr, PASSPHRASE);
      expect(tx.operations).toHaveLength(1);
      expect(tx.operations[0].type).toBe('changeTrust');
    });

    it('rejects when the wallet already has the USDC trustline', async () => {
      const service = makeService(makeCache(), platform.secret());
      const server = (
        service as unknown as { server: { loadAccount: jest.Mock } }
      ).server;
      server.loadAccount = jest
        .fn()
        .mockResolvedValue(
          fakeAccount(wallet.publicKey(), [usdcBalance(platform.publicKey())]),
        );

      await expect(
        service.prepareTrustline(wallet.publicKey()),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('rejects an unfunded wallet with a clear error', async () => {
      const service = makeService(makeCache(), platform.secret());
      const server = (
        service as unknown as { server: { loadAccount: jest.Mock } }
      ).server;
      server.loadAccount = jest.fn().mockRejectedValue(new Error('404'));

      await expect(
        service.prepareTrustline(wallet.publicKey()),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  describe('submitTrustline', () => {
    function buildSignedChangeTrust(
      platformKp: Keypair,
      walletKp: Keypair,
    ): string {
      const asset = new Asset('USDC', platformKp.publicKey());
      const account = fakeAccount(walletKp.publicKey());
      const tx = new TransactionBuilder(account, {
        fee: '100000',
        networkPassphrase: PASSPHRASE,
      })
        .addOperation(Operation.changeTrust({ asset }))
        .setTimeout(300)
        .build();
      tx.sign(walletKp);
      return tx.toXDR();
    }

    it('fee-bumps and submits a wallet-signed changeTrust tx', async () => {
      const service = makeService(makeCache(), platform.secret());
      const server = (
        service as unknown as { server: { submitTransaction: jest.Mock } }
      ).server;
      server.submitTransaction = jest.fn().mockResolvedValue({ hash: 'x' });

      const signedXdr = buildSignedChangeTrust(platform, wallet);
      const { txHash } = await service.submitTrustline(
        wallet.publicKey(),
        signedXdr,
      );

      expect(server.submitTransaction).toHaveBeenCalledTimes(1);
      expect(typeof txHash).toBe('string');
    });

    it('rejects a tx whose source does not match the given walletAddress', async () => {
      const service = makeService(makeCache(), platform.secret());
      const signedXdr = buildSignedChangeTrust(platform, wallet);
      const otherWallet = Keypair.random();

      await expect(
        service.submitTrustline(otherWallet.publicKey(), signedXdr),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejects a tx that is not a changeTrust call', async () => {
      const service = makeService(makeCache(), platform.secret());
      const account = fakeAccount(wallet.publicKey());
      const tx = new TransactionBuilder(account, {
        fee: '100000',
        networkPassphrase: PASSPHRASE,
      })
        .addOperation(
          Operation.payment({
            destination: platform.publicKey(),
            asset: Asset.native(),
            amount: '1',
          }),
        )
        .setTimeout(300)
        .build();
      tx.sign(wallet);

      await expect(
        service.submitTrustline(wallet.publicKey(), tx.toXDR()),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  describe('claim', () => {
    it('rejects an invalid wallet address before touching the network or cache', async () => {
      const cache = makeCache();
      const service = makeService(cache, platform.secret());

      await expect(service.claim('not-a-wallet')).rejects.toBeInstanceOf(
        BadRequestException,
      );
      // eslint-disable-next-line @typescript-eslint/unbound-method -- mock fn reference, never called unbound
      expect(cache.get).not.toHaveBeenCalled();
    });

    it('rejects while the cooldown is active', async () => {
      const cache = makeCache({ get: jest.fn().mockResolvedValue('1') });
      const service = makeService(cache, platform.secret());

      await expect(service.claim(wallet.publicKey())).rejects.toBeInstanceOf(
        ConflictException,
      );
    });

    it('rejects a wallet with no USDC trustline yet', async () => {
      const service = makeService(makeCache(), platform.secret());
      const server = (
        service as unknown as { server: { loadAccount: jest.Mock } }
      ).server;
      server.loadAccount = jest
        .fn()
        .mockResolvedValue(fakeAccount(wallet.publicKey(), []));

      await expect(service.claim(wallet.publicKey())).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    it('sends a platform-signed payment and sets the cooldown on success', async () => {
      const cache = makeCache();
      const service = makeService(cache, platform.secret());
      const server = (
        service as unknown as {
          server: { loadAccount: jest.Mock; submitTransaction: jest.Mock };
        }
      ).server;
      server.loadAccount = jest
        .fn()
        .mockImplementation((pubKey: string) =>
          pubKey === platform.publicKey()
            ? fakeAccount(platform.publicKey(), [])
            : fakeAccount(wallet.publicKey(), [
                usdcBalance(platform.publicKey()),
              ]),
        );
      server.submitTransaction = jest
        .fn()
        .mockResolvedValue({ hash: 'tx-hash' });

      const result = await service.claim(wallet.publicKey());

      expect(result).toEqual({
        txHash: 'tx-hash',
        amount: '1000',
        walletAddress: wallet.publicKey(),
      });
      // eslint-disable-next-line @typescript-eslint/unbound-method -- mock fn reference, never called unbound
      expect(cache.set).toHaveBeenCalledWith(
        `faucet:usdc:claim:${wallet.publicKey()}`,
        '1',
        86400,
      );
    });
  });
});
