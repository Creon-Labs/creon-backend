import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Interval } from '@nestjs/schedule';
import { CampaignDeployStatus } from '../../generated/prisma/enums';
import { fromStroops } from '../campaign/campaign.util';
import { CacheService } from '../cache/cache.service';
import { PrismaService } from '../prisma/prisma.service';
import { SorobanService } from '../soroban/soroban.service';

/** Valkey key holding the last ledger this loop has processed (a durable cursor). */
export const CURSOR_KEY = 'indexer:token-holding:cursor';

/** How often to poll for ShareToken events. Configurable so a demo can run it
 *  tighter than the 5-min reconcile loops without touching code. */
const POLL_INTERVAL_MS = Number(process.env.INDEXER_POLL_INTERVAL_MS ?? 30_000);

/**
 * Maintains {@link PrismaService.tokenHolding} (current share balances) by polling
 * Soroban RPC directly — SEP-41 is not enumerable on-chain and we run no
 * third-party indexer.
 *
 * Each poll asks RPC's `getEvents` which addresses a `LIVE` campaign's `ShareToken`
 * touched since the last processed ledger, then writes a **fresh on-chain
 * `balance()` read** for each — the balance is never decoded from the event body,
 * so a mis-parsed event can't corrupt the ledger. The cursor (last processed
 * ledger) lives in Valkey via {@link CacheService}, so a restart resumes without a
 * full rescan; on a cold start it seeds a bounded lookback from the latest ledger.
 *
 * Unlike the `campaign-deploy`/`kyc-whitelist` orchestrators this is a plain
 * `@Interval` service (no BullMQ): there's no per-entity retry, just one continuous
 * cursor-based loop. The cursor only advances on a fully successful poll, so a
 * failed poll simply re-reads the same window on the next tick.
 *
 * `INDEXER_LOOKBACK_LEDGERS` must stay under the RPC's per-request `getEvents`
 * ledger-range cap (empirically ~10000 ledgers on the public
 * `soroban-testnet.stellar.org` endpoint) — exceeding it doesn't error, it silently
 * returns zero events while still reporting the current tip as `latestLedger`,
 * which would advance the cursor straight past real events on a cold start
 * (verified 2026-07-03: a 17280 lookback lost two `mint` events this way).
 */
@Injectable()
export class TokenHoldingIndexerService implements OnApplicationBootstrap {
  private readonly logger = new Logger(TokenHoldingIndexerService.name);
  private readonly lookbackLedgers: number;
  /** Guards against a slow poll stacking on the interval. */
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly soroban: SorobanService,
    private readonly cache: CacheService,
    config: ConfigService,
  ) {
    this.lookbackLedgers = Number(
      config.get<string>('INDEXER_LOOKBACK_LEDGERS') ?? '9000',
    );
  }

  /** Poll once on boot so holdings are fresh without waiting a full interval. */
  onApplicationBootstrap(): Promise<void> {
    return this.poll();
  }

  @Interval(POLL_INTERVAL_MS)
  async poll(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      await this.runPoll();
    } catch (err) {
      // No queue here — the next tick re-reads the same window because the cursor
      // only advances on success.
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(`Token-holding poll failed: ${message}`);
    } finally {
      this.running = false;
    }
  }

  private async runPoll(): Promise<void> {
    // 1. LIVE campaigns with a deployed ShareToken → map its address to the campaign.
    const campaigns = await this.prisma.campaign.findMany({
      where: {
        deployStatus: CampaignDeployStatus.LIVE,
        projectToken: { contractAddress: { not: null } },
      },
      select: {
        id: true,
        projectToken: { select: { contractAddress: true } },
      },
    });
    const campaignByToken = new Map<string, string>();
    for (const c of campaigns) {
      const addr = c.projectToken?.contractAddress;
      if (addr) campaignByToken.set(addr, c.id);
    }
    if (campaignByToken.size === 0) return;

    // 2. Cursor: resume from the last processed ledger, or seed a bounded lookback.
    const startLedger = await this.resolveStartLedger();

    // 3. Fetch events since the cursor for every LIVE ShareToken.
    const { events, latestLedger } = await this.soroban.getContractEvents(
      [...campaignByToken.keys()],
      startLedger,
    );

    // 4. Collect the distinct (token, holder) pairs the events touched.
    const touched = new Map<string, { tokenAddr: string; holder: string }>();
    for (const event of events) {
      const campaignId = campaignByToken.get(event.contractId);
      if (!campaignId) continue; // event from a contract we don't track
      for (const holder of event.addresses) {
        touched.set(`${event.contractId}:${holder}`, {
          tokenAddr: event.contractId,
          holder,
        });
      }
    }

    // 5. Re-read each touched balance on-chain and upsert the holding.
    for (const { tokenAddr, holder } of touched.values()) {
      const campaignId = campaignByToken.get(tokenAddr)!;
      await this.syncHolding(campaignId, tokenAddr, holder, latestLedger);
    }

    // 6. Advance the cursor even on an empty poll so we never reprocess a window.
    await this.cache.set(CURSOR_KEY, String(latestLedger));
    if (touched.size) {
      this.logger.log(
        `Synced ${touched.size} holding(s) up to ledger ${latestLedger}`,
      );
    }
  }

  /** The ledger to start this poll from: the saved cursor + 1, or (cold start) a
   *  bounded lookback from the network's latest ledger. */
  private async resolveStartLedger(): Promise<number> {
    const saved = await this.cache.get(CURSOR_KEY);
    if (saved !== null) return Number(saved) + 1;
    const latest = await this.soroban.latestLedger();
    return Math.max(1, latest - this.lookbackLedgers);
  }

  /** Read the holder's real on-chain balance and upsert its `TokenHolding` row. */
  private async syncHolding(
    campaignId: string,
    tokenAddr: string,
    holderAddress: string,
    ledger: number,
  ): Promise<void> {
    const balance = fromStroops(
      await this.soroban.readBalance(tokenAddr, holderAddress),
    );
    // Registered investor if the address maps to a user; otherwise an anonymous
    // on-chain holder (e.g. a secondary-market recipient after unlock).
    const user = await this.prisma.user.findUnique({
      where: { walletAddress: holderAddress },
      select: { id: true },
    });
    await this.prisma.tokenHolding.upsert({
      where: { campaignId_holderAddress: { campaignId, holderAddress } },
      create: {
        campaignId,
        holderAddress,
        holderId: user?.id ?? null,
        balance,
        updatedLedger: BigInt(ledger),
      },
      update: {
        holderId: user?.id ?? null,
        balance,
        updatedLedger: BigInt(ledger),
      },
    });
  }
}
