import { ConfigService } from '@nestjs/config';
import { Account, Address, Keypair } from '@stellar/stellar-sdk';
import { SorobanService } from './soroban.service';

const PASSPHRASE = 'Test SDF Network ; September 2015';
const DEPLOYER = 'GCHPJMNH7WWIHX7CY5CKWR3I35A5DK4X6IU7CJSFUDHTBEWWMI6VEHFJ';
const SOME_CONTRACT =
  'CCTB7KFSZCWSIB3UGYTSDO5PBWMTKD5XCDIEGIEAYVPZSH5K3S5RANQ7';

function makeService(secret?: string): SorobanService {
  const config = {
    getOrThrow: (k: string) => {
      const map: Record<string, string | undefined> = {
        STELLAR_RPC_URL: 'https://soroban-testnet.stellar.org',
        STELLAR_NETWORK_PASSPHRASE: PASSPHRASE,
        STELLAR_PLATFORM_SECRET: secret,
      };
      const v = map[k];
      if (v === undefined) throw new Error(`missing ${k}`);
      return v;
    },
    get: () => undefined,
  } as unknown as ConfigService;
  return new SorobanService(config);
}

describe('SorobanService', () => {
  describe('pure helpers', () => {
    const service = makeService();

    it('derives a valid, deterministic contract address from (deployer, salt)', () => {
      const salt = service.saltFor('campaign-1:token');
      const a = service.deriveContractAddress(DEPLOYER, salt);
      const b = service.deriveContractAddress(DEPLOYER, salt);
      expect(a).toMatch(/^C[A-Z2-7]{55}$/);
      expect(a).toBe(b);
    });

    it('produces different addresses for different salts', () => {
      const token = service.deriveContractAddress(
        DEPLOYER,
        service.saltFor('c1:token'),
      );
      const campaign = service.deriveContractAddress(
        DEPLOYER,
        service.saltFor('c1:campaign'),
      );
      expect(token).not.toBe(campaign);
    });

    it('saltFor is deterministic and 32 bytes', () => {
      expect(service.saltFor('x')).toEqual(service.saltFor('x'));
      expect(service.saltFor('x')).toHaveLength(32);
    });

    it('builds ScVal args without throwing', () => {
      expect(service.addressArg(DEPLOYER).switch()).toBeDefined();
      expect(service.stringArg('Warung Bu Sri').switch()).toBeDefined();
      expect(service.i128Arg(1000_0000000n).switch()).toBeDefined();
      expect(service.u64Arg(2592000n).switch()).toBeDefined();
    });
  });

  describe('deployFromWasmHash', () => {
    it('recovers an already-deployed instance instead of redeploying', async () => {
      const service = makeService(Keypair.random().secret());
      jest.spyOn(service, 'contractExists').mockResolvedValue(true);
      const submit = jest.spyOn(service as never, 'submit' as never);

      const res = await service.deployFromWasmHash(
        'ab'.repeat(32),
        [],
        service.saltFor('c1:token'),
      );

      expect(res.txHash).toBeNull();
      expect(res.contractAddress).toMatch(/^C[A-Z2-7]{55}$/);
      expect(submit).not.toHaveBeenCalled();
    });

    it('deploys and returns the address from the tx return value', async () => {
      const service = makeService(Keypair.random().secret());
      jest.spyOn(service, 'contractExists').mockResolvedValue(false);
      mockServer(service, {
        returnValue: Address.fromString(SOME_CONTRACT).toScVal(),
      });

      const res = await service.deployFromWasmHash(
        'cd'.repeat(32),
        [],
        service.saltFor('c1:token'),
      );

      expect(res.contractAddress).toBe(SOME_CONTRACT);
      expect(res.txHash).toBe('txhash123');
    });
  });

  describe('invokeContract', () => {
    it('submits and returns the tx hash', async () => {
      const service = makeService(Keypair.random().secret());
      mockServer(service, { returnValue: undefined });

      const res = await service.invokeContract(SOME_CONTRACT, 'set_minter', [
        service.addressArg(SOME_CONTRACT),
      ]);

      expect(res.txHash).toBe('txhash123');
    });
  });
});

/** Stub the network layer so submit() flows through build → prepare → send → poll. */
function mockServer(
  service: SorobanService,
  opts: {
    returnValue: ReturnType<typeof Address.prototype.toScVal> | undefined;
  },
): void {
  const server = (service as unknown as { server: Record<string, jest.Mock> })
    .server;
  server.getAccount = jest.fn().mockResolvedValue(new Account(DEPLOYER, '0'));
  server.prepareTransaction = jest.fn().mockResolvedValue({ sign: jest.fn() });
  server.sendTransaction = jest
    .fn()
    .mockResolvedValue({ status: 'PENDING', hash: 'txhash123' });
  server.pollTransaction = jest.fn().mockResolvedValue({
    status: 'SUCCESS',
    txHash: 'txhash123',
    returnValue: opts.returnValue,
  });
}
