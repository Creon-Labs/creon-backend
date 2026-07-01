import { ConfigService } from '@nestjs/config';
import { CacheService } from '../cache/cache.service';
import { PrismaService } from '../prisma/prisma.service';
import { SorobanService } from '../soroban/soroban.service';
import {
  CURSOR_KEY,
  TokenHoldingIndexerService,
} from './token-holding-indexer.service';

const TOKEN = 'CCTB7KFSZCWSIB3UGYTSDO5PBWMTKD5XCDIEGIEAYVPZSH5K3S5RANQ7';
const HOLDER = 'GCUQRLMIYPTNGYQBEN6P6HMTDAETLKYEQORMQWV7SKNTX7XDDNN3OCBY';

function makeDeps() {
  const prisma = {
    campaign: { findMany: jest.fn().mockResolvedValue([]) },
    user: { findUnique: jest.fn().mockResolvedValue(null) },
    tokenHolding: { upsert: jest.fn().mockResolvedValue({}) },
  };
  const soroban = {
    getContractEvents: jest
      .fn()
      .mockResolvedValue({ events: [], latestLedger: 100 }),
    readBalance: jest.fn().mockResolvedValue(0n),
    latestLedger: jest.fn().mockResolvedValue(1000),
  };
  const cache = {
    get: jest.fn().mockResolvedValue(null),
    set: jest.fn().mockResolvedValue(undefined),
  };
  const config = {
    get: (k: string) => (k === 'INDEXER_LOOKBACK_LEDGERS' ? '200' : undefined),
  } as unknown as ConfigService;
  const service = new TokenHoldingIndexerService(
    prisma as unknown as PrismaService,
    soroban as unknown as SorobanService,
    cache as unknown as CacheService,
    config,
  );
  return { service, prisma, soroban, cache };
}

/** A LIVE campaign row with a deployed ShareToken. */
function liveCampaign(id = 'camp-1', token = TOKEN) {
  return { id, projectToken: { contractAddress: token } };
}

/** The first (and only) argument passed to `tokenHolding.upsert`, typed. */
type UpsertArg = {
  where: {
    campaignId_holderAddress: { campaignId: string; holderAddress: string };
  };
  create: {
    holderId: string | null;
    balance: { toString(): string };
    updatedLedger: bigint;
  };
};
function firstUpsertArg(upsert: jest.Mock): UpsertArg {
  return (upsert.mock.calls as unknown[][])[0][0] as UpsertArg;
}

describe('TokenHoldingIndexerService', () => {
  it('does nothing (no RPC) when there are no LIVE campaigns with a token', async () => {
    const { service, prisma, soroban, cache } = makeDeps();
    prisma.campaign.findMany.mockResolvedValue([]);

    await service.poll();

    expect(soroban.getContractEvents).not.toHaveBeenCalled();
    expect(cache.set).not.toHaveBeenCalled();
    expect(prisma.tokenHolding.upsert).not.toHaveBeenCalled();
  });

  it('reads a fresh balance for each touched holder and upserts the holding', async () => {
    const { service, prisma, soroban } = makeDeps();
    prisma.campaign.findMany.mockResolvedValue([liveCampaign()]);
    prisma.user.findUnique.mockResolvedValue({ id: 'user-1' });
    soroban.getContractEvents.mockResolvedValue({
      events: [{ contractId: TOKEN, addresses: [HOLDER], ledger: 880 }],
      latestLedger: 900,
    });
    soroban.readBalance.mockResolvedValue(50_0000000n); // 50.0000000 units

    await service.poll();

    expect(soroban.readBalance).toHaveBeenCalledWith(TOKEN, HOLDER);
    expect(prisma.tokenHolding.upsert).toHaveBeenCalledTimes(1);
    const arg = firstUpsertArg(prisma.tokenHolding.upsert);
    expect(arg.where).toEqual({
      campaignId_holderAddress: { campaignId: 'camp-1', holderAddress: HOLDER },
    });
    expect(arg.create.holderId).toBe('user-1');
    expect(arg.create.balance.toString()).toBe('50');
    expect(arg.create.updatedLedger).toBe(900n);
  });

  it('records an unregistered holder with a null holderId', async () => {
    const { service, prisma, soroban } = makeDeps();
    prisma.campaign.findMany.mockResolvedValue([liveCampaign()]);
    prisma.user.findUnique.mockResolvedValue(null);
    soroban.getContractEvents.mockResolvedValue({
      events: [{ contractId: TOKEN, addresses: [HOLDER], ledger: 880 }],
      latestLedger: 900,
    });

    await service.poll();

    expect(
      firstUpsertArg(prisma.tokenHolding.upsert).create.holderId,
    ).toBeNull();
  });

  it('dedupes repeated (token, holder) pairs into a single balance read', async () => {
    const { service, prisma, soroban } = makeDeps();
    prisma.campaign.findMany.mockResolvedValue([liveCampaign()]);
    soroban.getContractEvents.mockResolvedValue({
      events: [
        { contractId: TOKEN, addresses: [HOLDER], ledger: 880 },
        { contractId: TOKEN, addresses: [HOLDER], ledger: 881 },
      ],
      latestLedger: 900,
    });

    await service.poll();

    expect(soroban.readBalance).toHaveBeenCalledTimes(1);
    expect(prisma.tokenHolding.upsert).toHaveBeenCalledTimes(1);
  });

  it('seeds the start ledger from a lookback on a cold start (no cursor)', async () => {
    const { service, prisma, soroban, cache } = makeDeps();
    prisma.campaign.findMany.mockResolvedValue([liveCampaign()]);
    cache.get.mockResolvedValue(null);
    soroban.latestLedger.mockResolvedValue(1000);

    await service.poll();

    // lookback 200 → start at 1000 - 200 = 800
    expect(soroban.getContractEvents).toHaveBeenCalledWith([TOKEN], 800);
  });

  it('resumes from the saved cursor + 1', async () => {
    const { service, prisma, soroban, cache } = makeDeps();
    prisma.campaign.findMany.mockResolvedValue([liveCampaign()]);
    cache.get.mockResolvedValue('500');

    await service.poll();

    expect(soroban.latestLedger).not.toHaveBeenCalled();
    expect(soroban.getContractEvents).toHaveBeenCalledWith([TOKEN], 501);
  });

  it('advances the cursor to latestLedger even when no events matched', async () => {
    const { service, prisma, soroban, cache } = makeDeps();
    prisma.campaign.findMany.mockResolvedValue([liveCampaign()]);
    cache.get.mockResolvedValue('500');
    soroban.getContractEvents.mockResolvedValue({
      events: [],
      latestLedger: 640,
    });

    await service.poll();

    expect(cache.set).toHaveBeenCalledWith(CURSOR_KEY, '640');
    expect(prisma.tokenHolding.upsert).not.toHaveBeenCalled();
  });

  it('does not advance the cursor when the poll throws (retries same window)', async () => {
    const { service, prisma, soroban, cache } = makeDeps();
    prisma.campaign.findMany.mockResolvedValue([liveCampaign()]);
    cache.get.mockResolvedValue('500');
    soroban.getContractEvents.mockRejectedValue(new Error('rpc down'));

    // poll() swallows the error (no queue to retry it); the next tick re-reads.
    await expect(service.poll()).resolves.toBeUndefined();

    expect(cache.set).not.toHaveBeenCalled();
  });
});
