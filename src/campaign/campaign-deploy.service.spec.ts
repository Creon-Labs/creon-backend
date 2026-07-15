import { ConfigService } from '@nestjs/config';
import { Queue } from 'bullmq';
import { Prisma } from '../../generated/prisma/client';
import {
  CampaignDeployStatus,
  CampaignStatus,
} from '../../generated/prisma/enums';
import { PrismaService } from '../prisma/prisma.service';
import { SorobanService } from '../soroban/soroban.service';
import { CampaignDeployService } from './campaign-deploy.service';

const CONFIG: Record<string, string> = {
  COMPLIANCE_REGISTRY_ADDRESS: 'CREG',
  USDC_CONTRACT_ADDRESS: 'CUSDC',
  SHARE_TOKEN_WASM_HASH: 'sharehash',
  CAMPAIGN_WASM_HASH: 'camphash',
};

const anyArray = expect.any(Array) as unknown;
const anyBuffer = expect.any(Buffer) as unknown;

function makeDeps() {
  const prisma = {
    campaign: {
      findUnique: jest.fn(),
      findUniqueOrThrow: jest.fn().mockResolvedValue({
        proposal: { fundingDurationDays: 30 },
      }),
      update: jest.fn().mockResolvedValue({}),
      findMany: jest.fn().mockResolvedValue([]),
    },
    projectToken: { update: jest.fn().mockResolvedValue({}) },
  };
  const soroban = {
    platformPublicKey: 'GPLATFORM',
    addressArg: jest.fn((x: string) => ({ address: x })),
    stringArg: jest.fn((x: string) => ({ string: x })),
    i128Arg: jest.fn((x: bigint) => ({ i128: x })),
    i128VecArg: jest.fn((xs: bigint[]) => ({ i128vec: xs })),
    u64Arg: jest.fn((x: bigint) => ({ u64: x })),
    saltFor: jest.fn((s: string) => Buffer.from(s)),
    deployFromWasmHash: jest.fn(),
    invokeContract: jest.fn(),
    simulateRead: jest.fn().mockResolvedValue({ u64: 2_592_000n }),
    readU64: jest.fn((value: { u64: bigint }) => value.u64),
  };
  const config = {
    getOrThrow: (k: string) => CONFIG[k],
  } as unknown as ConfigService;
  const queue = {
    add: jest.fn().mockResolvedValue(undefined),
    remove: jest.fn().mockResolvedValue(undefined),
  };
  const service = new CampaignDeployService(
    prisma as unknown as PrismaService,
    soroban as unknown as SorobanService,
    config,
    queue as unknown as Queue,
  );
  return { service, prisma, soroban, queue };
}

function makeCampaign(overrides: Record<string, unknown> = {}) {
  return {
    id: 'camp-1',
    contractAddress: null,
    goalAmount: new Prisma.Decimal('1000'),
    deployStatus: CampaignDeployStatus.PENDING,
    wireTxHash: null,
    projectToken: { contractAddress: null, assetCode: 'WARUNGBU1234' },
    proposal: {
      businessName: 'Warung Bu Sri',
      fundingDurationDays: 30,
      lockPeriodDays: 30,
      entrepreneur: { walletAddress: 'GBUSINESS' },
    },
    milestones: [
      { amount: new Prisma.Decimal('600'), onchainIndex: 0 },
      { amount: new Prisma.Decimal('400'), onchainIndex: 1 },
    ],
    ...overrides,
  };
}

/** Asserts the campaign was flipped LIVE (matches the markLive update among many). */
function expectMarkedLive(
  prisma: ReturnType<typeof makeDeps>['prisma'],
  extra: Record<string, unknown> = {},
) {
  expect(prisma.campaign.update).toHaveBeenCalledWith(
    expect.objectContaining({
      data: expect.objectContaining({
        deployStatus: CampaignDeployStatus.LIVE,
        ...extra,
      }) as unknown,
    }) as unknown,
  );
}

describe('CampaignDeployService.drive', () => {
  it('deploys token + campaign, wires the minter, then marks LIVE/ACTIVE', async () => {
    const { service, prisma, soroban } = makeDeps();
    prisma.campaign.findUnique.mockResolvedValue(makeCampaign());
    soroban.deployFromWasmHash
      .mockResolvedValueOnce({ contractAddress: 'CTOKEN', txHash: 'txtoken' })
      .mockResolvedValueOnce({ contractAddress: 'CCAMP', txHash: 'txcamp' });
    soroban.invokeContract.mockResolvedValue({ txHash: 'txwire' });

    await service.drive('camp-1');

    expect(soroban.deployFromWasmHash).toHaveBeenNthCalledWith(
      1,
      'sharehash',
      anyArray,
      anyBuffer,
    );
    expect(soroban.deployFromWasmHash).toHaveBeenNthCalledWith(
      2,
      'camphash',
      anyArray,
      anyBuffer,
    );
    expect(prisma.projectToken.update).toHaveBeenCalledWith({
      where: { campaignId: 'camp-1' },
      data: { contractAddress: 'CTOKEN', deployTxHash: 'txtoken' },
    });
    expect(prisma.campaign.update).toHaveBeenCalledWith({
      where: { id: 'camp-1' },
      data: { contractAddress: 'CCAMP', deployTxHash: 'txcamp' },
    });
    expect(soroban.invokeContract).toHaveBeenCalledWith(
      'CTOKEN',
      'set_minter',
      anyArray,
    );
    expect(prisma.campaign.update).toHaveBeenCalledWith({
      where: { id: 'camp-1' },
      data: { wireTxHash: 'txwire' },
    });
    expectMarkedLive(prisma, {
      status: CampaignStatus.ACTIVE,
      vault: {
        update: expect.objectContaining({
          contractAddress: 'CCAMP',
        }) as unknown,
      },
    });
  });

  it('passes goal, funding duration, and lock period (seconds) to the Campaign constructor', async () => {
    const { service, prisma, soroban } = makeDeps();
    prisma.campaign.findUnique.mockResolvedValue(makeCampaign());
    soroban.deployFromWasmHash
      .mockResolvedValueOnce({ contractAddress: 'CTOKEN', txHash: 't' })
      .mockResolvedValueOnce({ contractAddress: 'CCAMP', txHash: 't' });
    soroban.invokeContract.mockResolvedValue({ txHash: 'w' });

    await service.drive('camp-1');

    expect(soroban.i128Arg).toHaveBeenCalledWith(10_000_000_000n); // 1000 * 1e7
    expect(soroban.u64Arg).toHaveBeenCalledWith(BigInt(30 * 86_400));
    // milestone_amounts Vec in stroops: 600 & 400 * 1e7, in onchainIndex order.
    expect(soroban.i128VecArg).toHaveBeenCalledWith([
      6_000_000_000n,
      4_000_000_000n,
    ]);
  });

  it('resumes from a deployed token: deploys only the campaign, no token redeploy', async () => {
    const { service, prisma, soroban } = makeDeps();
    prisma.campaign.findUnique.mockResolvedValue(
      makeCampaign({
        deployStatus: CampaignDeployStatus.DEPLOYING_CAMPAIGN,
        projectToken: { contractAddress: 'CTOKEN', assetCode: 'X' },
      }),
    );
    soroban.deployFromWasmHash.mockResolvedValueOnce({
      contractAddress: 'CCAMP',
      txHash: 'txcamp',
    });
    soroban.invokeContract.mockResolvedValue({ txHash: 'txwire' });

    await service.drive('camp-1');

    expect(soroban.deployFromWasmHash).toHaveBeenCalledTimes(1);
    expect(soroban.deployFromWasmHash).toHaveBeenCalledWith(
      'camphash',
      anyArray,
      anyBuffer,
    );
    expect(prisma.projectToken.update).not.toHaveBeenCalled();
    expectMarkedLive(prisma);
  });

  it('resumes from a deployed campaign: only wires the minter', async () => {
    const { service, prisma, soroban } = makeDeps();
    prisma.campaign.findUnique.mockResolvedValue(
      makeCampaign({
        deployStatus: CampaignDeployStatus.WIRING,
        contractAddress: 'CCAMP',
        projectToken: { contractAddress: 'CTOKEN', assetCode: 'X' },
      }),
    );
    soroban.invokeContract.mockResolvedValue({ txHash: 'txwire' });

    await service.drive('camp-1');

    expect(soroban.deployFromWasmHash).not.toHaveBeenCalled();
    expect(soroban.invokeContract).toHaveBeenCalledWith(
      'CTOKEN',
      'set_minter',
      anyArray,
    );
    expectMarkedLive(prisma);
  });

  it('resumes from a wired campaign straight to LIVE (no chain calls)', async () => {
    const { service, prisma, soroban } = makeDeps();
    prisma.campaign.findUnique.mockResolvedValue(
      makeCampaign({
        deployStatus: CampaignDeployStatus.WIRING,
        contractAddress: 'CCAMP',
        wireTxHash: 'txwire',
        projectToken: { contractAddress: 'CTOKEN', assetCode: 'X' },
      }),
    );

    await service.drive('camp-1');

    expect(soroban.deployFromWasmHash).not.toHaveBeenCalled();
    expect(soroban.invokeContract).not.toHaveBeenCalled();
    expectMarkedLive(prisma);
  });

  it('does nothing when already LIVE', async () => {
    const { service, prisma, soroban } = makeDeps();
    prisma.campaign.findUnique.mockResolvedValue(
      makeCampaign({ deployStatus: CampaignDeployStatus.LIVE }),
    );

    await service.drive('camp-1');

    expect(soroban.deployFromWasmHash).not.toHaveBeenCalled();
    expect(prisma.campaign.update).not.toHaveBeenCalled();
  });

  it('marks FAILED with the error and rethrows for BullMQ to retry', async () => {
    const { service, prisma, soroban } = makeDeps();
    prisma.campaign.findUnique.mockResolvedValue(makeCampaign());
    soroban.deployFromWasmHash.mockRejectedValue(new Error('rpc down'));

    await expect(service.drive('camp-1')).rejects.toThrow('rpc down');

    expect(prisma.campaign.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          deployStatus: CampaignDeployStatus.FAILED,
          deployError: 'rpc down',
          deployAttempts: { increment: 1 },
        }) as unknown,
      }) as unknown,
    );
  });
});

describe('CampaignDeployService queueing', () => {
  it('enqueue clears any stale job then adds with jobId = campaignId', async () => {
    const { service, queue } = makeDeps();
    await service.enqueue('camp-1');
    expect(queue.remove).toHaveBeenCalledWith('camp-1');
    expect(queue.add).toHaveBeenCalledWith(
      'deploy',
      { campaignId: 'camp-1' },
      expect.objectContaining({ jobId: 'camp-1' }) as unknown,
    );
  });

  it('reconcile re-enqueues every not-yet-LIVE campaign', async () => {
    const { service, prisma, queue } = makeDeps();
    prisma.campaign.findMany.mockResolvedValue([{ id: 'a' }, { id: 'b' }]);
    await service.reconcile();
    expect(prisma.campaign.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { deployStatus: { not: CampaignDeployStatus.LIVE } },
      }) as unknown,
    );
    expect(queue.add).toHaveBeenCalledTimes(2);
  });
});
