/**
 * Real on-chain e2e test for the automatic `unlock()` trigger
 * (src/campaign/campaign-unlock.service.ts), against a locally running app
 * (`pnpm start:dev`) + Stellar testnet, reusing the wallets from setup-wallets.ts.
 *
 * A 1-day `lockPeriodDays` (the DTO minimum) can't be waited out in a test run, so
 * this backdates `Campaign.lockEndAt` directly in Postgres — the same manual-smoke-test
 * shortcut described in the unlock-mechanism plan. Everything else (proposal, approval,
 * on-chain deploy, on-chain invest, the reconcile loop discovering the due campaign, the
 * real `unlock()` invocation, and the on-chain `is_locked()` read-back) is 100% real.
 *
 * Run: npx tsx scripts/e2e/unlock-flow.ts   (after setup-wallets.ts; app must be running)
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { config as loadEnv } from 'dotenv';
import {
  Account,
  Keypair,
  Operation,
  TransactionBuilder,
  rpc,
} from '@stellar/stellar-sdk';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../../generated/prisma/client';

const ROOT = join(__dirname, '..', '..');
loadEnv({ path: join(ROOT, '.env') });

const BASE_URL = `http://localhost:${process.env.PORT ?? 3000}`;
const NETWORK_PASSPHRASE = process.env.STELLAR_NETWORK_PASSPHRASE!;
const RPC_URL = process.env.STELLAR_RPC_URL!;
/** Name of the httpOnly cookie AuthController sets the JWT under (auth-cookie.constants.ts). */
const AUTH_COOKIE_NAME = 'creon_access_token';

interface Wallet {
  role: 'admin' | 'entrepreneur' | 'investor1' | 'investor2';
  publicKey: string;
  secretKey: string;
}
const wallets: Wallet[] = JSON.parse(
  readFileSync(join(__dirname, 'wallets.local.json'), 'utf8'),
);
function wallet(role: Wallet['role']): Wallet {
  const w = wallets.find((x) => x.role === role);
  if (!w) throw new Error(`wallet not found for role ${role}; run setup-wallets.ts first`);
  return w;
}

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
});
const server = new rpc.Server(RPC_URL);

async function apiRequest(
  method: string,
  path: string,
  opts: { token?: string; body?: unknown; form?: FormData } = {},
): Promise<any> {
  const headers: Record<string, string> = {};
  if (opts.token) headers['Authorization'] = `Bearer ${opts.token}`;
  let body: BodyInit | undefined;
  if (opts.form) {
    body = opts.form;
  } else if (opts.body !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(opts.body);
  }
  const res = await fetch(`${BASE_URL}${path}`, { method, headers, body });
  const text = await res.text();
  let json: any;
  try {
    json = text ? JSON.parse(text) : undefined;
  } catch {
    json = text;
  }
  if (!res.ok) {
    throw new Error(`${method} ${path} -> ${res.status}: ${JSON.stringify(json)}`);
  }
  // Every response is enveloped as { statusCode, message, data } — see CLAUDE.md's
  // "Every HTTP response is enveloped" convention.
  return json?.data;
}

function signChallenge(kp: Keypair, message: string): string {
  return kp.sign(Buffer.from(message)).toString('base64');
}
function signXdr(kp: Keypair, xdr: string): string {
  const tx = TransactionBuilder.fromXDR(xdr, NETWORK_PASSPHRASE);
  tx.sign(kp);
  return tx.toXDR();
}

async function pollUntil<T>(
  label: string,
  fn: () => Promise<T>,
  predicate: (v: T) => boolean,
  opts: { intervalMs?: number; timeoutMs?: number } = {},
): Promise<T> {
  const interval = opts.intervalMs ?? 5000;
  const timeout = opts.timeoutMs ?? 90000;
  const start = Date.now();
  for (;;) {
    const v = await fn();
    if (predicate(v)) {
      console.log(`  ✓ ${label} = ${JSON.stringify(v)}`);
      return v;
    }
    if (Date.now() - start > timeout) {
      throw new Error(`Timeout waiting for ${label} (last value: ${JSON.stringify(v)})`);
    }
    await new Promise((r) => setTimeout(r, interval));
  }
}

async function challengeMessage(publicKey: string): Promise<string> {
  const res = await apiRequest('POST', '/auth/challenge', { body: { walletAddress: publicKey } });
  return res.message;
}

/** The JWT is delivered only as an httpOnly Set-Cookie now, not in the response body
 *  (AuthController.setAuthCookie) — extract it directly and reuse it as a Bearer
 *  token, since JwtAuthGuard accepts either. */
async function loginWallet(w: Wallet): Promise<string> {
  const kp = Keypair.fromSecret(w.secretKey);
  const message = await challengeMessage(w.publicKey);
  const signature = signChallenge(kp, message);
  const res = await fetch(`${BASE_URL}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ walletAddress: w.publicKey, signature }),
  });
  if (!res.ok) {
    throw new Error(`POST /auth/login -> ${res.status}: ${await res.text()}`);
  }
  const setCookies = res.headers.getSetCookie();
  const authCookie = setCookies
    .map((c) => c.split(';')[0])
    .find((c) => c.startsWith(`${AUTH_COOKIE_NAME}=`));
  if (!authCookie) {
    throw new Error(`No ${AUTH_COOKIE_NAME} cookie in /auth/login response`);
  }
  return decodeURIComponent(authCookie.slice(AUTH_COOKIE_NAME.length + 1));
}

/** Read-only ShareToken.is_locked() — no signing, no submit. Mirrors SorobanService.simulateRead. */
async function isLocked(contractId: string): Promise<boolean> {
  const platformKp = Keypair.fromSecret(process.env.STELLAR_PLATFORM_SECRET!);
  const tx = new TransactionBuilder(new Account(platformKp.publicKey(), '0'), {
    fee: '100',
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(
      Operation.invokeContractFunction({
        contract: contractId,
        function: 'is_locked',
        args: [],
      }),
    )
    .setTimeout(60)
    .build();
  const sim = await server.simulateTransaction(tx);
  if (!rpc.Api.isSimulationSuccess(sim) || !sim.result) {
    const detail = rpc.Api.isSimulationError(sim) ? sim.error : JSON.stringify(sim);
    throw new Error(`simulate ${contractId}.is_locked failed: ${detail}`);
  }
  return sim.result.retval.b();
}

async function main() {
  const adminW = wallet('admin');
  const entW = wallet('entrepreneur');
  const inv1W = wallet('investor1');
  const inv1Kp = Keypair.fromSecret(inv1W.secretKey);

  console.log('\n=== Login (reusing existing e2e wallets: entrepreneur/investor1/admin) ===');
  const entToken = await loginWallet(entW);
  const inv1Token = await loginWallet(inv1W);
  const adminToken = await loginWallet(adminW);
  console.log('  ✓ logged in as entrepreneur, investor1, admin');

  console.log('\n=== Proposal → approve → on-chain deploy (lockPeriodDays: 1, minimum allowed) ===');
  const proposal = await apiRequest('POST', '/proposals', {
    token: entToken,
    body: {
      businessName: 'Kedai Unlock E2E',
      businessDescription: 'e2e test proposal for the automatic unlock() trigger',
      category: 'F&B',
      location: 'Jakarta',
      requestedAmount: '100.0000000',
      lockPeriodDays: 1,
      milestones: [
        { order: 1, title: 'Single milestone', description: 'Not released in this test', amount: '100.0000000' },
      ],
    },
  });
  await apiRequest('POST', `/proposals/${proposal.id}/submit`, { token: entToken });
  await apiRequest('POST', `/admin/proposals/${proposal.id}/approve`, { token: adminToken });

  const campaign = await pollUntil(
    `Campaign row for proposal ${proposal.id}`,
    () => prisma.campaign.findUnique({ where: { proposalId: proposal.id } }),
    (c) => c !== null,
    { intervalMs: 1000, timeoutMs: 15000 },
  );
  await pollUntil(
    'Kedai Unlock E2E deployStatus LIVE',
    async () => (await prisma.campaign.findUnique({ where: { id: campaign!.id } }))!.deployStatus,
    (s) => s === 'LIVE',
    { intervalMs: 5000, timeoutMs: 180000 },
  );
  const campaignId = campaign!.id;

  console.log('\n=== Invest (investor1, 50 USDC of the 100 goal) ===');
  const prepared = await apiRequest('POST', `/campaigns/${campaignId}/investments/prepare`, {
    token: inv1Token,
    body: { amount: '50.0000000' },
  });
  const signedXdr = signXdr(inv1Kp, prepared.xdr);
  await apiRequest('POST', `/campaigns/${campaignId}/investments`, {
    token: inv1Token,
    body: { signedXdr },
  });
  await pollUntil(
    'TokenHolding count for Kedai Unlock E2E',
    () => prisma.tokenHolding.count({ where: { campaignId, holderId: { not: null } } }),
    (c) => c >= 1,
    { intervalMs: 10000, timeoutMs: 120000 },
  );

  const projectToken = await prisma.projectToken.findUniqueOrThrow({ where: { campaignId } });
  const shareTokenAddress = projectToken.contractAddress!;

  console.log('\n=== Pre-check: ShareToken is_locked() on-chain (expect true) ===');
  const lockedBefore = await isLocked(shareTokenAddress);
  console.log(`  ShareToken ${shareTokenAddress} is_locked() = ${lockedBefore}`);
  if (!lockedBefore) {
    throw new Error('Expected the ShareToken to be locked before the unlock trigger runs');
  }

  console.log(
    "\n=== Backdating Campaign.lockEndAt to the past (can't wait out a real 1-day lock in a test run) ===",
  );
  await prisma.campaign.update({
    where: { id: campaignId },
    data: { lockEndAt: new Date(Date.now() - 60_000) },
  });
  const before = await prisma.campaign.findUniqueOrThrow({ where: { id: campaignId } });
  console.log(`  unlockStatus before = ${before.unlockStatus}, lockEndAt = ${before.lockEndAt?.toISOString()}`);

  console.log(
    '\n=== Waiting for the campaign-unlock reconcile loop to pick this up (up to 5 min + on-chain tx time) ===',
  );
  const unlocked = await pollUntil(
    'Campaign.unlockStatus',
    async () => (await prisma.campaign.findUniqueOrThrow({ where: { id: campaignId } })).unlockStatus,
    (s) => s === 'UNLOCKED' || s === 'FAILED',
    { intervalMs: 10000, timeoutMs: 360000 },
  );
  if (unlocked === 'FAILED') {
    const failed = await prisma.campaign.findUniqueOrThrow({ where: { id: campaignId } });
    throw new Error(`Unlock orchestrator reported FAILED: ${failed.unlockError}`);
  }
  const final = await prisma.campaign.findUniqueOrThrow({ where: { id: campaignId } });
  console.log(`  ✓ unlockStatus = UNLOCKED, unlockTxHash = ${final.unlockTxHash}`);

  console.log('\n=== Post-check: ShareToken is_locked() on-chain (expect false) ===');
  const lockedAfter = await isLocked(shareTokenAddress);
  console.log(`  ShareToken ${shareTokenAddress} is_locked() = ${lockedAfter}`);
  if (lockedAfter) {
    throw new Error('unlock() ran but is_locked() still reports true on-chain');
  }

  console.log('\n========== RESULT ==========');
  console.log('✅ Automatic unlock() trigger verified end-to-end on Stellar testnet.');
  console.log(`   Campaign: ${campaignId}`);
  console.log(`   ShareToken: ${shareTokenAddress}`);
  console.log(`   unlock() tx: ${final.unlockTxHash}`);
  console.log(
    `   Explorer: https://stellar.expert/explorer/testnet/tx/${final.unlockTxHash}`,
  );
}

main()
  .catch((err) => {
    console.error('\n❌ Fatal error:', err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
