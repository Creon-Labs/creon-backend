import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '../../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { maskAddress, maskName } from './holding.util';

/** Own-holding fields for the caller's portfolio view (no masking — own data). */
const MINE_SELECT = {
  campaignId: true,
  balance: true,
  updatedLedger: true,
  campaign: {
    select: {
      status: true,
      projectToken: { select: { assetCode: true } },
    },
  },
} satisfies Prisma.TokenHoldingSelect;

/** Cap-table fields for the public campaign view (identity masked before return). */
const CAP_TABLE_SELECT = {
  holderAddress: true,
  balance: true,
  updatedLedger: true,
  holder: { select: { displayName: true } },
} satisfies Prisma.TokenHoldingSelect;

/**
 * Read surface over `TokenHolding` (maintained by the ownership indexer). Two views:
 * an investor's own portfolio, and a campaign's public — but identity-masked — cap
 * table. Both show only *current* holders (`balance > 0`), heaviest first.
 */
@Injectable()
export class HoldingService {
  constructor(private readonly prisma: PrismaService) {}

  /** The caller's own current holdings across all campaigns, largest first. */
  listMine(userId: string) {
    return this.prisma.tokenHolding.findMany({
      where: { holderId: userId, balance: { gt: 0 } },
      orderBy: { balance: 'desc' },
      select: MINE_SELECT,
    });
  }

  /** A campaign's cap table with wallet + name masked. 404 if the campaign is unknown. */
  async listForCampaign(campaignId: string) {
    const campaign = await this.prisma.campaign.findUnique({
      where: { id: campaignId },
      select: { id: true },
    });
    if (!campaign) {
      throw new NotFoundException('Campaign not found');
    }

    const holdings = await this.prisma.tokenHolding.findMany({
      where: { campaignId, balance: { gt: 0 } },
      orderBy: { balance: 'desc' },
      select: CAP_TABLE_SELECT,
    });

    return holdings.map((h) => ({
      holder: maskName(h.holder?.displayName ?? null),
      address: maskAddress(h.holderAddress),
      balance: h.balance,
      updatedLedger: h.updatedLedger,
    }));
  }
}
