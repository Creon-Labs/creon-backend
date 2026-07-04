import {
  BadRequestException,
  ConflictException,
  Injectable,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  Asset,
  Horizon,
  Keypair,
  Operation,
  StrKey,
  Transaction,
  TransactionBuilder,
} from '@stellar/stellar-sdk';
import { CacheService } from '../cache/cache.service';

const COOLDOWN_KEY_PREFIX = 'faucet:usdc:claim:';

/**
 * A public (unauthenticated) test-USDC faucet, so anyone — chiefly hackathon
 * judges — can self-service test USDC into their own wallet without touching
 * the repo. USDC here is a **classic Stellar asset** issued by the platform
 * key (see `contracts/deployments/testnet.json`'s `_comment`), so unlike the
 * Soroban contract calls in {@link SorobanService}, this operates on the
 * classic ledger via Horizon:
 *
 *  - `changeTrust` must be signed by the recipient wallet itself (one-time
 *    per wallet) — {@link prepareTrustline} builds the unsigned tx,
 *    {@link submitTrustline} fee-bumps + submits the wallet-signed one.
 *  - `payment` (the actual "mint") is signed **only** by the platform key,
 *    which is the asset's issuer — {@link claim} needs no signature from the
 *    caller at all.
 *
 * Claims are cooled down per wallet via {@link CacheService} (Valkey), mirror-
 * ing the `auth:challenge:<wallet>` key convention.
 */
@Injectable()
export class FaucetService {
  private readonly server: Horizon.Server;
  private readonly networkPassphrase: string;
  private readonly claimAmount: string;
  private readonly cooldownSeconds: number;
  private platformKeypair?: Keypair;

  constructor(
    private readonly config: ConfigService,
    private readonly cache: CacheService,
  ) {
    const horizonUrl = config.getOrThrow<string>('STELLAR_HORIZON_URL');
    this.networkPassphrase = config.getOrThrow<string>(
      'STELLAR_NETWORK_PASSPHRASE',
    );
    this.claimAmount = config.get<string>('FAUCET_USDC_AMOUNT') ?? '1000';
    this.cooldownSeconds = Number(
      config.get<string>('FAUCET_CLAIM_COOLDOWN_SECONDS') ?? '86400',
    );
    this.server = new Horizon.Server(horizonUrl, {
      allowHttp: horizonUrl.startsWith('http://'),
    });
  }

  /** Build an unsigned `changeTrust` tx (wallet as source) for the wallet to sign. */
  async prepareTrustline(walletAddress: string): Promise<{ xdr: string }> {
    const account = await this.loadAccountOrThrow(walletAddress);
    if (this.hasUsdcTrustline(account)) {
      throw new ConflictException(
        'Wallet already has a USDC trustline; call /faucet/usdc/claim directly',
      );
    }

    const tx = new TransactionBuilder(account, {
      fee: '100000',
      networkPassphrase: this.networkPassphrase,
    })
      .addOperation(Operation.changeTrust({ asset: this.usdcAsset() }))
      // Generous window so the wallet has time to sign.
      .setTimeout(300)
      .build();

    return { xdr: tx.toXDR() };
  }

  /** Verify + fee-bump + submit a wallet-signed `changeTrust` tx. */
  async submitTrustline(
    walletAddress: string,
    signedXdr: string,
  ): Promise<{ txHash: string }> {
    const tx = this.decodeChangeTrustOrThrow(signedXdr, walletAddress);
    const platform = this.platform();
    const feeBump = TransactionBuilder.buildFeeBumpTransaction(
      platform,
      tx.fee,
      tx,
      this.networkPassphrase,
    );
    feeBump.sign(platform);
    await this.server.submitTransaction(feeBump);
    return { txHash: tx.hash().toString('hex') };
  }

  /** Send a platform-signed `payment` (the "mint") to the wallet; no client signature needed. */
  async claim(
    walletAddress: string,
  ): Promise<{ txHash: string; amount: string; walletAddress: string }> {
    if (!StrKey.isValidEd25519PublicKey(walletAddress)) {
      throw new BadRequestException(
        'walletAddress is not a valid Stellar public key',
      );
    }

    const cooldownKey = `${COOLDOWN_KEY_PREFIX}${walletAddress}`;
    if (await this.cache.get(cooldownKey)) {
      throw new ConflictException(
        'USDC already claimed for this wallet; try again later',
      );
    }

    const account = await this.loadAccountOrThrow(walletAddress);
    if (!this.hasUsdcTrustline(account)) {
      throw new BadRequestException(
        'Wallet has no USDC trustline yet; call /faucet/usdc/trustline/prepare first',
      );
    }

    const platform = this.platform();
    const platformAccount = await this.server.loadAccount(platform.publicKey());
    const tx = new TransactionBuilder(platformAccount, {
      fee: '100000',
      networkPassphrase: this.networkPassphrase,
    })
      .addOperation(
        Operation.payment({
          destination: walletAddress,
          asset: this.usdcAsset(),
          amount: this.claimAmount,
        }),
      )
      .setTimeout(60)
      .build();
    tx.sign(platform);
    const result = await this.server.submitTransaction(tx);

    await this.cache.set(cooldownKey, '1', this.cooldownSeconds);
    return {
      txHash: result.hash,
      amount: this.claimAmount,
      walletAddress,
    };
  }

  private usdcAsset(): Asset {
    return new Asset('USDC', this.platform().publicKey());
  }

  private hasUsdcTrustline(account: Horizon.AccountResponse): boolean {
    const issuer = this.platform().publicKey();
    return account.balances.some(
      (b) =>
        b.asset_type !== 'native' &&
        'asset_code' in b &&
        b.asset_code === 'USDC' &&
        'asset_issuer' in b &&
        b.asset_issuer === issuer,
    );
  }

  private async loadAccountOrThrow(
    walletAddress: string,
  ): Promise<Horizon.AccountResponse> {
    if (!StrKey.isValidEd25519PublicKey(walletAddress)) {
      throw new BadRequestException(
        'walletAddress is not a valid Stellar public key',
      );
    }
    try {
      return await this.server.loadAccount(walletAddress);
    } catch {
      throw new BadRequestException(
        'Wallet not found on-chain; fund it with testnet XLM via friendbot first',
      );
    }
  }

  /** Decode a signed tx and assert it's a single USDC `changeTrust` sourced by `walletAddress`. */
  private decodeChangeTrustOrThrow(
    signedXdr: string,
    walletAddress: string,
  ): Transaction {
    let tx: Transaction | ReturnType<typeof TransactionBuilder.fromXDR>;
    try {
      tx = TransactionBuilder.fromXDR(signedXdr, this.networkPassphrase);
    } catch {
      throw new BadRequestException('Malformed transaction XDR');
    }
    if (!(tx instanceof Transaction)) {
      throw new BadRequestException(
        'Expected a signed inner transaction, got a fee-bump',
      );
    }
    if (tx.operations.length !== 1) {
      throw new BadRequestException(
        'Transaction must contain exactly one operation',
      );
    }
    const [op] = tx.operations;
    if (op.type !== 'changeTrust') {
      throw new BadRequestException('Transaction is not a changeTrust() call');
    }
    const issuer = this.platform().publicKey();
    if (
      !(op.line instanceof Asset) ||
      op.line.getCode() !== 'USDC' ||
      op.line.getIssuer() !== issuer
    ) {
      throw new BadRequestException(
        'Transaction does not trust the platform USDC asset',
      );
    }
    const source = op.source ?? tx.source;
    if (source !== walletAddress) {
      throw new BadRequestException(
        'Transaction source is not the given walletAddress',
      );
    }
    return tx;
  }

  /** Lazily build the platform signer so the app boots without a faucet key. */
  private platform(): Keypair {
    if (!this.platformKeypair) {
      this.platformKeypair = Keypair.fromSecret(
        this.config.getOrThrow<string>('STELLAR_PLATFORM_SECRET'),
      );
    }
    return this.platformKeypair;
  }
}
