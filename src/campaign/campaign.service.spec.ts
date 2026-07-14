import { NotFoundException } from '@nestjs/common';
import { Prisma } from '../../generated/prisma/client';
import {
  CampaignDeployStatus,
  CampaignStatus,
  MilestoneStatus,
  VaultStatus,
} from '../../generated/prisma/enums';
import { PrismaService } from '../prisma/prisma.service';
import { StorageService } from '../storage/storage.service';
import { CampaignService } from './campaign.service';

function makeStorage() {
  return {
    getPublicUrl: jest.fn((key: string) => `https://cdn.example/${key}`),
    getPresignedDownloadUrl: jest
      .fn()
      .mockResolvedValue('https://signed.example/file'),
  } as unknown as StorageService;
}

describe('CampaignService', () => {
  const create = jest.fn().mockResolvedValue({ id: 'camp-1' });
  const milestoneUpdateMany = jest.fn().mockResolvedValue({ count: 2 });
  const mediaUpdateMany = jest.fn().mockResolvedValue({ count: 1 });
  const tx = {
    campaign: { create },
    milestone: { updateMany: milestoneUpdateMany },
    proposalMedia: { updateMany: mediaUpdateMany },
  } as unknown as Prisma.TransactionClient;
  const service = new CampaignService({} as PrismaService, makeStorage());

  beforeEach(() => {
    create.mockClear();
    milestoneUpdateMany.mockClear();
    mediaUpdateMany.mockClear();
  });

  const proposal = {
    id: 'prop-1',
    businessName: 'Warung Bu Sri',
    requestedAmount: new Prisma.Decimal('1000'),
    lockPeriodDays: 30,
  };

  it('creates the campaign + token + vault rows in PENDING_DEPLOYMENT', async () => {
    const result = await service.createForProposal(tx, proposal);
    expect(result).toEqual({ id: 'camp-1' });

    expect(create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        proposalId: 'prop-1',
        goalAmount: proposal.requestedAmount,
        status: CampaignStatus.PENDING_DEPLOYMENT,
        deployStatus: CampaignDeployStatus.PENDING,
        lockEndAt: expect.any(Date) as unknown,
        projectToken: {
          create: expect.objectContaining({
            isTransferable: false,
            assetCode: expect.stringMatching(/^WARUNGBU/) as unknown,
          }) as unknown,
        },
        vault: {
          create: expect.objectContaining({
            status: VaultStatus.PENDING,
          }) as unknown,
        },
      }) as unknown,
      select: { id: true },
    });
  });

  it('sets lockEndAt lockPeriodDays into the future', async () => {
    const before = Date.now();
    await service.createForProposal(tx, proposal);
    const [arg] = create.mock.calls[0] as [{ data: { lockEndAt: Date } }];
    const expected = before + 30 * 86_400 * 1000;
    expect(arg.data.lockEndAt.getTime()).toBeGreaterThanOrEqual(
      expected - 5000,
    );
  });

  it('links the proposal milestones to the new campaign (PENDING)', async () => {
    await service.createForProposal(tx, proposal);
    expect(milestoneUpdateMany).toHaveBeenCalledWith({
      where: { proposalId: 'prop-1' },
      data: { campaignId: 'camp-1', status: MilestoneStatus.PENDING },
    });
  });

  it('links proposal media to the new campaign (no object copy)', async () => {
    await service.createForProposal(tx, proposal);
    expect(mediaUpdateMany).toHaveBeenCalledWith({
      where: { proposalId: 'prop-1' },
      data: { campaignId: 'camp-1' },
    });
  });
});

describe('CampaignService public reads', () => {
  function makeService() {
    const prisma = {
      campaign: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: 'camp-1',
            proposal: {
              businessName: 'Warung Bu Sri',
              businessDescription: 'Warung makan keluarga',
              media: [
                {
                  id: 'm1',
                  kind: 'IMAGE',
                  mimeType: 'image/jpeg',
                  originalName: 'a.jpg',
                  sizeBytes: 10,
                  sortOrder: 0,
                  objectKey: 'proposals/p1/images/a.jpg',
                  createdAt: new Date(),
                },
              ],
            },
          },
        ]),
        findUnique: jest.fn(),
      },
    };
    const storage = makeStorage();
    const service = new CampaignService(
      prisma as unknown as PrismaService,
      storage,
    );
    return { service, prisma, storage };
  }

  it('listActive returns only LIVE-deployed campaigns with media URLs', async () => {
    const { service, prisma } = makeService();
    const result = await service.listActive();
    expect(result).toEqual([
      {
        id: 'camp-1',
        businessName: 'Warung Bu Sri',
        businessDescription: 'Warung makan keluarga',
        media: [
          expect.objectContaining({
            id: 'm1',
            url: 'https://cdn.example/proposals/p1/images/a.jpg',
          }),
        ],
      },
    ]);
    expect(result[0].media[0]).not.toHaveProperty('objectKey');
    expect(result[0]).not.toHaveProperty('proposal');
    expect(prisma.campaign.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { deployStatus: CampaignDeployStatus.LIVE },
      }) as unknown,
    );
  });

  it('getPublic returns the campaign when found', async () => {
    const { service, prisma } = makeService();
    prisma.campaign.findUnique.mockResolvedValue({
      id: 'camp-1',
      proposal: {
        businessName: 'Warung Bu Sri',
        businessDescription: 'Warung makan keluarga',
        media: [],
      },
    });
    await expect(service.getPublic('camp-1')).resolves.toEqual({
      id: 'camp-1',
      businessName: 'Warung Bu Sri',
      businessDescription: 'Warung makan keluarga',
      media: [],
    });
  });

  it('getPublic 404s an unknown campaign', async () => {
    const { service, prisma } = makeService();
    prisma.campaign.findUnique.mockResolvedValue(null);
    await expect(service.getPublic('nope')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});

/**
 * **Validates: Requirements 1.1, 1.2, 1.3**
 * 
 * Property 1: Bug Condition - Media Empty When campaignId is NULL
 * 
 * This test demonstrates the bug where campaigns return empty media arrays
 * when ProposalMedia.campaignId is NULL, even though media exists linked to
 * the proposal.
 * 
 * Bug Condition: campaign.deployStatus = 'LIVE' AND campaign.proposal.media.length > 0
 *                AND campaign.media.length = 0 (due to campaignId = NULL)
 * 
 * Expected Behavior (after fix): Media should be retrieved via proposal.media relation,
 * ensuring all media associated with the campaign's proposal is returned.
 * 
 * CRITICAL: This test WILL FAIL on unfixed code - that failure confirms the bug exists.
 * DO NOT attempt to fix the test when it fails on unfixed code.
 * After implementing the fix, this same test should PASS.
 */
describe('Property 1: Bug Condition - Campaign Media Empty Bug', () => {
  function makeServiceWithBugCondition() {
    const prisma = {
      campaign: {
        findUnique: jest.fn(),
        findMany: jest.fn(),
      },
    };
    const storage = makeStorage();
    const service = new CampaignService(
      prisma as unknown as PrismaService,
      storage,
    );
    return { service, prisma, storage };
  }

  /**
   * Bug Case: Campaign with LIVE status has proposal with uploaded media,
   * but campaign.media returns empty array because ProposalMedia.campaignId = NULL.
   * 
   * This simulates the real-world scenario where updateMany() in createForProposal()
   * silently fails to set campaignId on ProposalMedia records.
   */
  it('should return media from proposal relation when campaignId is NULL (bug condition)', async () => {
    const { service, prisma } = makeServiceWithBugCondition();
    
    // Mock data representing the bug condition:
    // - Campaign exists with deployStatus = LIVE
    // - Proposal has media uploaded (3 images)
    // - proposal.media has the actual media records (source of truth)
    // After fix, this data will be returned via proposal.media relation
    const mockCampaignData = {
      id: 'camp-bug-1',
      contractAddress: '0xABC123',
      goalAmount: new Prisma.Decimal('1000'),
      raisedAmount: new Prisma.Decimal('0'),
      status: CampaignStatus.PENDING_DEPLOYMENT,
      deployStatus: CampaignDeployStatus.LIVE,
      lockEndAt: new Date(),
      unlockStatus: null,
      unlockTxHash: null,
      startAt: new Date(),
      endAt: new Date(),
      projectToken: {
        assetCode: 'TESTTOKEN',
        contractAddress: '0xTOKEN',
      },
      proposal: {
        businessName: 'Test Business',
        businessDescription: 'A test business with media',
        // The fix ensures media is returned from this nested structure
        media: [
          {
            id: 'pm1',
            kind: 'IMAGE',
            mimeType: 'image/jpeg',
            originalName: 'bug-test1.jpg',
            sizeBytes: 1024,
            sortOrder: 0,
            objectKey: 'proposals/def-456/images/bug-test1.jpg',
            createdAt: new Date(),
          },
          {
            id: 'pm2',
            kind: 'IMAGE',
            mimeType: 'image/png',
            originalName: 'bug-test2.png',
            sizeBytes: 2048,
            sortOrder: 1,
            objectKey: 'proposals/def-456/images/bug-test2.png',
            createdAt: new Date(),
          },
          {
            id: 'pm3',
            kind: 'IMAGE',
            mimeType: 'image/webp',
            originalName: 'bug-test3.webp',
            sizeBytes: 3072,
            sortOrder: 2,
            objectKey: 'proposals/def-456/images/bug-test3.webp',
            createdAt: new Date(),
          },
        ],
      },
    };

    prisma.campaign.findUnique.mockResolvedValue(mockCampaignData);

    const result = await service.getPublic('camp-bug-1');

    // EXPECTED BEHAVIOR (after fix): Media should be returned from proposal relation
    // The fix ensures media is fetched via proposal.media relation
    expect(result.media).toBeDefined();
    expect(result.media.length).toBe(3);
    expect(result.media.length).toBeGreaterThan(0);
    
    // Verify media URLs are valid presigned URLs
    expect(result.media[0]).toHaveProperty('url');
    expect(result.media[0].url).toMatch(/^https:\/\//);
    expect(result.media[0].url).toBe('https://cdn.example/proposals/def-456/images/bug-test1.jpg');
    
    // Verify media is sorted by sortOrder ascending
    expect(result.media[0].sortOrder).toBe(0);
    expect(result.media[1].sortOrder).toBe(1);
    expect(result.media[2].sortOrder).toBe(2);
  });

  /**
   * Bug Case for listActive: Multiple campaigns, some with bug condition
   * 
   * This tests the list endpoint where campaigns with NULL campaignId return
   * empty media arrays.
   */
  it('should return media for all campaigns in listActive when campaignId is NULL', async () => {
    const { service, prisma } = makeServiceWithBugCondition();
    
    // Mock data for list query with bug condition
    const mockCampaignsData = [
      {
        id: 'camp-bug-list-1',
        contractAddress: '0xABC123',
        goalAmount: new Prisma.Decimal('1000'),
        raisedAmount: new Prisma.Decimal('0'),
        status: CampaignStatus.PENDING_DEPLOYMENT,
        deployStatus: CampaignDeployStatus.LIVE,
        lockEndAt: new Date(),
        unlockStatus: null,
        unlockTxHash: null,
        startAt: new Date(),
        endAt: new Date(),
        projectToken: {
          assetCode: 'TEST1',
          contractAddress: '0xTOKEN1',
        },
        proposal: {
          businessName: 'Business 1',
          businessDescription: 'Description 1',
          media: [
            {
              id: 'pm-list-1',
              kind: 'IMAGE',
              mimeType: 'image/jpeg',
              originalName: 'list-bug1.jpg',
              sizeBytes: 1024,
              sortOrder: 0,
              objectKey: 'proposals/p-list-1/images/list-bug1.jpg',
              createdAt: new Date(),
            },
          ],
        },
      },
      {
        id: 'camp-bug-list-2',
        contractAddress: '0xDEF456',
        goalAmount: new Prisma.Decimal('2000'),
        raisedAmount: new Prisma.Decimal('0'),
        status: CampaignStatus.PENDING_DEPLOYMENT,
        deployStatus: CampaignDeployStatus.LIVE,
        lockEndAt: new Date(),
        unlockStatus: null,
        unlockTxHash: null,
        startAt: new Date(),
        endAt: new Date(),
        projectToken: {
          assetCode: 'TEST2',
          contractAddress: '0xTOKEN2',
        },
        proposal: {
          businessName: 'Business 2',
          businessDescription: 'Description 2',
          media: [
            {
              id: 'pm-list-2',
              kind: 'IMAGE',
              mimeType: 'image/png',
              originalName: 'list-bug2.png',
              sizeBytes: 2048,
              sortOrder: 0,
              objectKey: 'proposals/p-list-2/images/list-bug2.png',
              createdAt: new Date(),
            },
          ],
        },
      },
    ];

    prisma.campaign.findMany.mockResolvedValue(mockCampaignsData);

    const result = await service.listActive();

    // EXPECTED BEHAVIOR (after fix): All campaigns should have their media returned
    expect(result).toHaveLength(2);
    
    // After fix, these campaigns return media from proposal.media
    expect(result[0].media).toBeDefined();
    expect(result[0].media.length).toBe(1);
    expect(result[1].media).toBeDefined();
    expect(result[1].media.length).toBe(1);
  });
});

/**
 * Property 2: Preservation - Non-Buggy Campaign Queries Unchanged
 * 
 * This test suite verifies that campaigns which do NOT have the bug condition
 * (campaigns with correctly set campaignId, campaigns with no media, etc.)
 * continue to work correctly both before and after the fix.
 * 
 * These tests follow the observation-first methodology:
 * 1. Observe behavior on UNFIXED code for non-buggy inputs
 * 2. Write tests capturing that behavior
 * 3. Verify tests PASS on UNFIXED code (baseline)
 * 4. After fix, tests should still PASS (no regressions)
 * 
 * CRITICAL: These tests SHOULD PASS on unfixed code.
 */
describe('Property 2: Preservation - Non-Buggy Campaign Queries', () => {
  function makeService() {
    const prisma = {
      campaign: {
        findMany: jest.fn(),
        findUnique: jest.fn(),
      },
    };
    const storage = makeStorage();
    const service = new CampaignService(
      prisma as unknown as PrismaService,
      storage,
    );
    return { service, prisma, storage };
  }

  /**
   * Preservation Case 1: Campaign with correctly set campaignId returns media
   * 
   * This represents campaigns where the updateMany() succeeded and campaignId
   * is properly set on ProposalMedia records. These should work correctly
   * both before and after the fix.
   */
  it('should preserve correct behavior for campaigns with correctly set campaignId', async () => {
    const { service, prisma } = makeService();
    
    // Mock data: campaign.media has records (campaignId is correctly set)
    const mockCampaignData = {
      id: 'camp-correct-1',
      contractAddress: '0xCORRECT',
      goalAmount: new Prisma.Decimal('1000'),
      raisedAmount: new Prisma.Decimal('500'),
      status: CampaignStatus.PENDING_DEPLOYMENT,
      deployStatus: CampaignDeployStatus.LIVE,
      lockEndAt: new Date(),
      unlockStatus: null,
      unlockTxHash: null,
      startAt: new Date(),
      endAt: new Date(),
      projectToken: {
        assetCode: 'CORRECT',
        contractAddress: '0xTOKEN',
      },
      proposal: {
        businessName: 'Correct Campaign',
        businessDescription: 'This campaign has media correctly linked',
        media: [
          {
            id: 'm1',
            kind: 'IMAGE',
            mimeType: 'image/jpeg',
            originalName: 'correct.jpg',
            sizeBytes: 1024,
            sortOrder: 0,
            objectKey: 'proposals/p1/images/correct.jpg',
            createdAt: new Date(),
          },
          {
            id: 'm2',
            kind: 'IMAGE',
            mimeType: 'image/png',
            originalName: 'correct2.png',
            sizeBytes: 2048,
            sortOrder: 1,
            objectKey: 'proposals/p1/images/correct2.png',
            createdAt: new Date(),
          },
        ],
      },
    };

    prisma.campaign.findUnique.mockResolvedValue(mockCampaignData);

    const result = await service.getPublic('camp-correct-1');

    // Observed behavior on unfixed code: media is returned correctly
    expect(result.media).toBeDefined();
    expect(result.media.length).toBe(2);
    expect(result.media[0]).toHaveProperty('url');
    expect(result.media[0].url).toBe('https://cdn.example/proposals/p1/images/correct.jpg');
    expect(result.media[1].url).toBe('https://cdn.example/proposals/p1/images/correct2.png');
    
    // Verify media response format is preserved
    expect(result.media[0]).toHaveProperty('id');
    expect(result.media[0]).toHaveProperty('kind');
    expect(result.media[0]).toHaveProperty('mimeType');
    expect(result.media[0]).toHaveProperty('originalName');
    expect(result.media[0]).toHaveProperty('sizeBytes');
    expect(result.media[0]).toHaveProperty('sortOrder');
    expect(result.media[0]).not.toHaveProperty('objectKey'); // Should be stripped
  });

  /**
   * Preservation Case 2: Campaign with no media returns empty array
   * 
   * Campaigns with zero uploaded media files should return empty arrays,
   * both before and after the fix.
   */
  it('should preserve empty media array for campaigns with no media uploaded', async () => {
    const { service, prisma } = makeService();
    
    const mockCampaignData = {
      id: 'camp-no-media-1',
      contractAddress: '0xNOMEDIA',
      goalAmount: new Prisma.Decimal('1000'),
      raisedAmount: new Prisma.Decimal('0'),
      status: CampaignStatus.PENDING_DEPLOYMENT,
      deployStatus: CampaignDeployStatus.LIVE,
      lockEndAt: new Date(),
      unlockStatus: null,
      unlockTxHash: null,
      startAt: new Date(),
      endAt: new Date(),
      projectToken: {
        assetCode: 'NOMEDIA',
        contractAddress: '0xTOKEN',
      },
      proposal: {
        businessName: 'No Media Campaign',
        businessDescription: 'This campaign has no media',
        media: [],
      },
    };

    prisma.campaign.findUnique.mockResolvedValue(mockCampaignData);

    const result = await service.getPublic('camp-no-media-1');

    // Observed behavior on unfixed code: empty array for campaigns with no media
    expect(result.media).toBeDefined();
    expect(result.media).toEqual([]);
    expect(result.media.length).toBe(0);
  });

  /**
   * Preservation Case 3: Media sorting by sortOrder is preserved
   * 
   * Media should always be sorted by sortOrder ascending, regardless of the fix.
   */
  it('should preserve media sorting by sortOrder ascending', async () => {
    const { service, prisma } = makeService();
    
    const mockCampaignData = {
      id: 'camp-sorted-1',
      contractAddress: '0xSORTED',
      goalAmount: new Prisma.Decimal('1000'),
      raisedAmount: new Prisma.Decimal('0'),
      status: CampaignStatus.PENDING_DEPLOYMENT,
      deployStatus: CampaignDeployStatus.LIVE,
      lockEndAt: new Date(),
      unlockStatus: null,
      unlockTxHash: null,
      startAt: new Date(),
      endAt: new Date(),
      projectToken: {
        assetCode: 'SORTED',
        contractAddress: '0xTOKEN',
      },
      proposal: {
        businessName: 'Sorted Media Campaign',
        businessDescription: 'Media is sorted',
        media: [
          {
            id: 'm1',
            kind: 'IMAGE',
            mimeType: 'image/jpeg',
            originalName: 'first.jpg',
            sizeBytes: 1024,
            sortOrder: 0,
            objectKey: 'proposals/p1/images/first.jpg',
            createdAt: new Date(),
          },
          {
            id: 'm2',
            kind: 'IMAGE',
            mimeType: 'image/png',
            originalName: 'second.png',
            sizeBytes: 2048,
            sortOrder: 1,
            objectKey: 'proposals/p1/images/second.png',
            createdAt: new Date(),
          },
          {
            id: 'm3',
            kind: 'DOCUMENT',
            mimeType: 'application/pdf',
            originalName: 'third.pdf',
            sizeBytes: 4096,
            sortOrder: 2,
            objectKey: 'proposals/p1/documents/third.pdf',
            createdAt: new Date(),
          },
        ],
      },
    };

    prisma.campaign.findUnique.mockResolvedValue(mockCampaignData);

    const result = await service.getPublic('camp-sorted-1');

    // Observed behavior: media is sorted by sortOrder
    expect(result.media.length).toBe(3);
    expect(result.media[0].sortOrder).toBe(0);
    expect(result.media[1].sortOrder).toBe(1);
    expect(result.media[2].sortOrder).toBe(2);
    expect(result.media[0].originalName).toBe('first.jpg');
    expect(result.media[1].originalName).toBe('second.png');
    expect(result.media[2].originalName).toBe('third.pdf');
  });

  /**
   * Preservation Case 4: Campaigns in non-LIVE status are queryable
   * 
   * Campaigns in PENDING_DEPLOYMENT and other statuses should continue
   * to be queryable without errors.
   */
  it('should preserve behavior for campaigns in non-LIVE deployment status', async () => {
    const { service, prisma } = makeService();
    
    const mockCampaignData = {
      id: 'camp-pending-1',
      contractAddress: null,
      goalAmount: new Prisma.Decimal('1000'),
      raisedAmount: new Prisma.Decimal('0'),
      status: CampaignStatus.PENDING_DEPLOYMENT,
      deployStatus: CampaignDeployStatus.PENDING,
      lockEndAt: new Date(),
      unlockStatus: null,
      unlockTxHash: null,
      startAt: null,
      endAt: null,
      projectToken: {
        assetCode: 'PENDING',
        contractAddress: null,
      },
      proposal: {
        businessName: 'Pending Campaign',
        businessDescription: 'Not yet deployed',
        media: [],
      },
    };

    prisma.campaign.findUnique.mockResolvedValue(mockCampaignData);

    // Should not throw error
    const result = await service.getPublic('camp-pending-1');

    expect(result).toBeDefined();
    expect(result.id).toBe('camp-pending-1');
    expect(result.deployStatus).toBe(CampaignDeployStatus.PENDING);
  });

  /**
   * Preservation Case 5: Presigned URL generation continues to work
   * 
   * The mapMediaToResponse function should continue to generate
   * presigned URLs correctly for all media kinds.
   */
  it('should preserve presigned URL generation for all media', async () => {
    const { service, prisma, storage } = makeService();
    
    const mockCampaignData = {
      id: 'camp-urls-1',
      contractAddress: '0xURLS',
      goalAmount: new Prisma.Decimal('1000'),
      raisedAmount: new Prisma.Decimal('0'),
      status: CampaignStatus.PENDING_DEPLOYMENT,
      deployStatus: CampaignDeployStatus.LIVE,
      lockEndAt: new Date(),
      unlockStatus: null,
      unlockTxHash: null,
      startAt: new Date(),
      endAt: new Date(),
      projectToken: {
        assetCode: 'URLS',
        contractAddress: '0xTOKEN',
      },
      proposal: {
        businessName: 'URL Test Campaign',
        businessDescription: 'Testing URLs',
        media: [
          {
            id: 'm1',
            kind: 'IMAGE',
            mimeType: 'image/jpeg',
            originalName: 'test.jpg',
            sizeBytes: 1024,
            sortOrder: 0,
            objectKey: 'proposals/p1/images/test.jpg',
            createdAt: new Date(),
          },
        ],
      },
    };

    prisma.campaign.findUnique.mockResolvedValue(mockCampaignData);

    const result = await service.getPublic('camp-urls-1');

    // Verify URL generation was called
    expect(storage.getPublicUrl).toHaveBeenCalledWith('proposals/p1/images/test.jpg');
    expect(result.media[0].url).toBe('https://cdn.example/proposals/p1/images/test.jpg');
  });

  /**
   * Preservation Case 6: listActive filters by LIVE deployStatus
   * 
   * The listActive method should continue to filter campaigns by
   * deployStatus = LIVE.
   */
  it('should preserve LIVE deployment status filtering in listActive', async () => {
    const { service, prisma } = makeService();
    
    prisma.campaign.findMany.mockResolvedValue([
      {
        id: 'camp-live-1',
        contractAddress: '0xLIVE1',
        goalAmount: new Prisma.Decimal('1000'),
        raisedAmount: new Prisma.Decimal('0'),
        status: CampaignStatus.PENDING_DEPLOYMENT,
        deployStatus: CampaignDeployStatus.LIVE,
        lockEndAt: new Date(),
        unlockStatus: null,
        unlockTxHash: null,
        startAt: new Date(),
        endAt: new Date(),
        projectToken: {
          assetCode: 'LIVE1',
          contractAddress: '0xTOKEN1',
        },
        proposal: {
          businessName: 'Live Campaign 1',
          businessDescription: 'First live campaign',
          media: [],
        },
      },
    ]);

    await service.listActive();

    // Verify the query filters by deployStatus = LIVE
    expect(prisma.campaign.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { deployStatus: CampaignDeployStatus.LIVE },
      }),
    );
  });
});
