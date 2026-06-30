import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  Address,
  Keypair,
  Operation,
  StrKey,
  TransactionBuilder,
  hash,
  nativeToScVal,
  rpc,
  xdr,
} from '@stellar/stellar-sdk';

/** Result of a contract deploy. `txHash` is null when the instance was recovered
 *  (already on-chain from a prior, crashed attempt) rather than freshly deployed. */
export interface DeployResult {
  contractAddress: string;
  txHash: string | null;
}

/**
 * Thin wrapper around the Soroban RPC + transaction-building surface of
 * `@stellar/stellar-sdk`, mirroring the {@link CacheService}/{@link StorageService}
 * pattern: `@Injectable`, configured entirely from environment via
 * {@link ConfigService} (see `.env.example`).
 *
 * All platform-side txs (contract deploys, `set_minter`, and — in later phases —
 * `registry.add`) are signed by the single platform key
 * (`STELLAR_PLATFORM_SECRET`), which is the `owner` of every contract it deploys.
 * The key is built lazily so the app can boot for non-chain work without it.
 *
 * Deploys are **idempotent**: a deterministic salt per (campaign, kind) means a
 * retry targets the same contract address, and {@link deployFromWasmHash}
 * pre-checks the chain so a crash *after* submitting but *before* persisting never
 * produces a duplicate contract.
 */
@Injectable()
export class SorobanService {
  private readonly logger = new Logger(SorobanService.name);
  private readonly server: rpc.Server;
  private readonly networkPassphrase: string;
  private readonly fee: string;
  private platformKeypair?: Keypair;

  constructor(private readonly config: ConfigService) {
    const rpcUrl = config.getOrThrow<string>('STELLAR_RPC_URL');
    this.networkPassphrase = config.getOrThrow<string>(
      'STELLAR_NETWORK_PASSPHRASE',
    );
    this.fee = config.get<string>('STELLAR_BASE_FEE') ?? '1000000';
    this.server = new rpc.Server(rpcUrl, {
      allowHttp: rpcUrl.startsWith('http://'),
    });
  }

  /** The platform public key (`G...`); also the `owner` of deployed contracts. */
  get platformPublicKey(): string {
    return this.platform().publicKey();
  }

  /**
   * Deploy a contract instance from an already-uploaded WASM hash, atomically
   * invoking its constructor. Idempotent: if the deterministic (deployer, salt)
   * instance already exists on-chain it is recovered instead of redeployed.
   */
  async deployFromWasmHash(
    wasmHash: string,
    constructorArgs: xdr.ScVal[],
    salt: Buffer,
  ): Promise<DeployResult> {
    const platform = this.platform();
    const predicted = this.deriveContractAddress(platform.publicKey(), salt);

    if (await this.contractExists(predicted)) {
      this.logger.warn(
        `Contract ${predicted} already deployed; recovering without redeploy`,
      );
      return { contractAddress: predicted, txHash: null };
    }

    const op = Operation.createCustomContract({
      address: Address.fromString(platform.publicKey()),
      wasmHash: Buffer.from(wasmHash, 'hex'),
      salt,
      constructorArgs,
    });
    const { result, txHash } = await this.submit(op);
    const contractAddress = result.returnValue
      ? Address.fromScVal(result.returnValue).toString()
      : predicted;
    this.logger.log(`Deployed contract ${contractAddress} (tx ${txHash})`);
    return { contractAddress, txHash };
  }

  /** Invoke a contract function, signed by the platform key. Returns the tx hash. */
  async invokeContract(
    contractId: string,
    func: string,
    args: xdr.ScVal[],
  ): Promise<{ txHash: string }> {
    const op = Operation.invokeContractFunction({
      contract: contractId,
      function: func,
      args,
    });
    const { txHash } = await this.submit(op);
    this.logger.log(`Invoked ${contractId}.${func} (tx ${txHash})`);
    return { txHash };
  }

  /** Whether a contract instance exists on-chain (idempotent-recovery probe). */
  async contractExists(contractId: string): Promise<boolean> {
    const key = xdr.LedgerKey.contractData(
      new xdr.LedgerKeyContractData({
        contract: Address.fromString(contractId).toScAddress(),
        key: xdr.ScVal.scvLedgerKeyContractInstance(),
        durability: xdr.ContractDataDurability.persistent(),
      }),
    );
    const res = await this.server.getLedgerEntries(key);
    return res.entries.length > 0;
  }

  /**
   * Canonical Soroban contract-id derivation — predicts the address that
   * `createCustomContract(deployer, salt)` produces, so a retry can recover the
   * instance deterministically instead of deploying a duplicate.
   */
  deriveContractAddress(deployer: string, salt: Buffer): string {
    const networkId = hash(Buffer.from(this.networkPassphrase));
    const preimage = xdr.HashIdPreimage.envelopeTypeContractId(
      new xdr.HashIdPreimageContractId({
        networkId,
        contractIdPreimage:
          xdr.ContractIdPreimage.contractIdPreimageFromAddress(
            new xdr.ContractIdPreimageFromAddress({
              address: Address.fromString(deployer).toScAddress(),
              salt,
            }),
          ),
      }),
    );
    return StrKey.encodeContract(hash(preimage.toXDR()));
  }

  /** Deterministic 32-byte salt for a (campaign, kind) pair → idempotent retries. */
  saltFor(seed: string): Buffer {
    return hash(Buffer.from(seed));
  }

  // ---- ScVal builders for constructor / invocation args ----
  addressArg(addr: string): xdr.ScVal {
    return Address.fromString(addr).toScVal();
  }
  /** Soroban `String` (the ShareToken `name`/`symbol` constructor params). */
  stringArg(value: string): xdr.ScVal {
    return nativeToScVal(value, { type: 'string' });
  }
  i128Arg(value: bigint): xdr.ScVal {
    return nativeToScVal(value, { type: 'i128' });
  }
  u64Arg(value: bigint): xdr.ScVal {
    return nativeToScVal(value, { type: 'u64' });
  }

  /** Build → simulate/assemble → sign → send → poll to a final status. */
  private async submit(op: xdr.Operation): Promise<{
    result: rpc.Api.GetSuccessfulTransactionResponse;
    txHash: string;
  }> {
    const platform = this.platform();
    const source = await this.server.getAccount(platform.publicKey());
    const tx = new TransactionBuilder(source, {
      fee: this.fee,
      networkPassphrase: this.networkPassphrase,
    })
      .addOperation(op)
      .setTimeout(60)
      .build();

    const prepared = await this.server.prepareTransaction(tx);
    prepared.sign(platform);

    const sent = await this.server.sendTransaction(prepared);
    if (sent.status === 'ERROR') {
      throw new Error(
        `sendTransaction rejected: ${JSON.stringify(sent.errorResult)}`,
      );
    }

    const result = await this.server.pollTransaction(sent.hash, {
      attempts: 30,
    });
    if (result.status !== rpc.Api.GetTransactionStatus.SUCCESS) {
      throw new Error(`tx ${sent.hash} ended ${result.status}`);
    }
    return { result, txHash: sent.hash };
  }

  /** Lazily build the platform signer so the app boots without a deploy key. */
  private platform(): Keypair {
    if (!this.platformKeypair) {
      this.platformKeypair = Keypair.fromSecret(
        this.config.getOrThrow<string>('STELLAR_PLATFORM_SECRET'),
      );
    }
    return this.platformKeypair;
  }
}
