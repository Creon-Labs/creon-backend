/**
 * Generates (or reuses) 4 real Stellar testnet wallets for the full e2e test:
 * admin, entrepreneur, investor1, investor2. Funds each with XLM via friendbot,
 * and establishes a USDC trustline + balance for entrepreneur/investor1/investor2
 * (admin never signs an on-chain tx, so it only needs XLM).
 *
 * Idempotent: reruns reuse keys already in wallets.local.json and skip funding
 * steps that are already satisfied, so this is safe to run again later.
 *
 * Run: npx tsx scripts/e2e/setup-wallets.ts
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { config as loadEnv } from 'dotenv';
import {
  Asset,
  Horizon,
  Keypair,
  Operation,
  TransactionBuilder,
} from '@stellar/stellar-sdk';

const ROOT = join(__dirname, '..', '..');
loadEnv({ path: join(ROOT, '.env') });

const WALLETS_PATH = join(__dirname, 'wallets.local.json');
const HORIZON_URL = 'https://horizon-testnet.stellar.org';
const FRIENDBOT_URL = 'https://friendbot.stellar.org';
const NETWORK_PASSPHRASE = process.env.STELLAR_NETWORK_PASSPHRASE!;
const PLATFORM_SECRET = process.env.STELLAR_PLATFORM_SECRET!;

const ROLES = ['admin', 'entrepreneur', 'investor1', 'investor2'] as const;
type Role = (typeof ROLES)[number];
/** Target USDC balance per role; admin never invests/deposits so it's omitted. */
const USDC_TARGETS: Partial<Record<Role, string>> = {
  entrepreneur: '200',
  investor1: '1000',
  investor2: '500',
};

interface WalletRecord {
  role: Role;
  publicKey: string;
  secretKey: string;
}

function loadWallets(): WalletRecord[] {
  if (!existsSync(WALLETS_PATH)) return [];
  return JSON.parse(readFileSync(WALLETS_PATH, 'utf8'));
}

function saveWallets(wallets: WalletRecord[]) {
  writeFileSync(WALLETS_PATH, JSON.stringify(wallets, null, 2) + '\n');
}

async function friendbotFund(publicKey: string) {
  const res = await fetch(`${FRIENDBOT_URL}/?addr=${publicKey}`);
  if (!res.ok && res.status !== 400) {
    throw new Error(`friendbot funding failed for ${publicKey}: ${res.status} ${await res.text()}`);
  }
}

async function main() {
  if (!NETWORK_PASSPHRASE || !PLATFORM_SECRET) {
    throw new Error('STELLAR_NETWORK_PASSPHRASE / STELLAR_PLATFORM_SECRET missing from .env');
  }
  const horizon = new Horizon.Server(HORIZON_URL);
  const platformKeypair = Keypair.fromSecret(PLATFORM_SECRET);
  const usdcAsset = new Asset('USDC', platformKeypair.publicKey());

  const wallets = loadWallets();
  const byRole = new Map(wallets.map((w) => [w.role, w]));

  for (const role of ROLES) {
    if (!byRole.has(role)) {
      const kp = Keypair.random();
      const record: WalletRecord = {
        role,
        publicKey: kp.publicKey(),
        secretKey: kp.secret(),
      };
      byRole.set(role, record);
      wallets.push(record);
      console.log(`[${role}] generated ${kp.publicKey()}`);
    } else {
      console.log(`[${role}] reusing ${byRole.get(role)!.publicKey}`);
    }
  }
  saveWallets(wallets);

  for (const role of ROLES) {
    const record = byRole.get(role)!;
    const kp = Keypair.fromSecret(record.secretKey);

    let account: Horizon.AccountResponse | null = null;
    try {
      account = await horizon.loadAccount(kp.publicKey());
    } catch {
      account = null;
    }

    if (!account) {
      console.log(`[${role}] funding via friendbot...`);
      await friendbotFund(kp.publicKey());
      account = await horizon.loadAccount(kp.publicKey());
    } else {
      console.log(`[${role}] already funded on-chain`);
    }

    const target = USDC_TARGETS[role];
    if (!target) continue; // admin: no USDC needed

    const hasTrustline = account.balances.some(
      (b) =>
        b.asset_type !== 'native' &&
        'asset_code' in b &&
        b.asset_code === 'USDC' &&
        'asset_issuer' in b &&
        b.asset_issuer === usdcAsset.getIssuer(),
    );

    if (!hasTrustline) {
      console.log(`[${role}] establishing USDC trustline...`);
      const tx = new TransactionBuilder(account, {
        fee: '100000',
        networkPassphrase: NETWORK_PASSPHRASE,
      })
        .addOperation(Operation.changeTrust({ asset: usdcAsset }))
        .setTimeout(60)
        .build();
      tx.sign(kp);
      await horizon.submitTransaction(tx);
      account = await horizon.loadAccount(kp.publicKey());
    }

    const currentBalance = Number(
      account.balances.find(
        (b) =>
          b.asset_type !== 'native' &&
          'asset_code' in b &&
          b.asset_code === 'USDC',
      )?.balance ?? '0',
    );
    const targetAmount = Number(target);
    if (currentBalance < targetAmount) {
      const topUp = (targetAmount - currentBalance).toFixed(7);
      console.log(`[${role}] topping up ${topUp} USDC (have ${currentBalance})...`);
      const platformAccount = await horizon.loadAccount(platformKeypair.publicKey());
      const tx = new TransactionBuilder(platformAccount, {
        fee: '100000',
        networkPassphrase: NETWORK_PASSPHRASE,
      })
        .addOperation(
          Operation.payment({
            destination: kp.publicKey(),
            asset: usdcAsset,
            amount: topUp,
          }),
        )
        .setTimeout(60)
        .build();
      tx.sign(platformKeypair);
      await horizon.submitTransaction(tx);
    } else {
      console.log(`[${role}] already has ${currentBalance} USDC (>= ${targetAmount})`);
    }
  }

  console.log('\nWallets ready:');
  for (const role of ROLES) {
    console.log(`  ${role}: ${byRole.get(role)!.publicKey}`);
  }
  console.log(`\nPersisted to ${WALLETS_PATH}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
