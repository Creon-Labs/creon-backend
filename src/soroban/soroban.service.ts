import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  Account,
  Address,
  FeeBumpTransaction,
  Keypair,
  Operation,
  StrKey,
  Transaction,
  TransactionBuilder,
  hash,
  nativeToScVal,
  rpc,
  scValToNative,
  xdr,
} from '@stellar/stellar-sdk';

/** Result of a contract deploy. `txHash` is null when the instance was recovered
 *  (already on-chain from a prior, crashed attempt) rather than freshly deployed. */
export interface DeployResult {
  contractAddress: string;
  txHash: string | null;
}

/** A ShareToken event reduced to what the ownership indexer needs: which token
 *  emitted it and which holder addresses it touched. Amounts are deliberately
 *  omitted — the indexer re-reads each balance on-chain rather than trusting the
 *  event body. */
export interface TokenEvent {
  contractId: string;
  addresses: string[];
  ledger: number;
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
  /** RPC caps a getEvents request at 5 contract filters. */
  private static readonly MAX_CONTRACT_FILTERS = 5;
  /** Page size for getEvents cursor pagination. */
  private static readonly EVENTS_PAGE_LIMIT = 200;

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

  /**
   * Build a contract invocation **sourced at `source`** (not the platform),
   * simulate/assemble it, and return the unsigned prepared **XDR** for a client
   * wallet to sign. Used by the investment flow: `invest()` requires the
   * investor's own auth (and pulls their USDC), so the investor must be the
   * source and signer — the platform can only sponsor the fee (see
   * {@link submitSignedTransaction}). Because the investor is the source, a
   * single envelope signature covers both the top-level call and the inner
   * `usdc.transfer` auth.
   */
  async buildInvokeTransaction(
    source: string,
    contractId: string,
    func: string,
    args: xdr.ScVal[],
  ): Promise<string> {
    const account = await this.server.getAccount(source);
    const tx = new TransactionBuilder(account, {
      fee: this.fee,
      networkPassphrase: this.networkPassphrase,
    })
      .addOperation(
        Operation.invokeContractFunction({
          contract: contractId,
          function: func,
          args,
        }),
      )
      // Generous window so the investor has time to sign in their wallet.
      .setTimeout(300)
      .build();

    const prepared = await this.server.prepareTransaction(tx);
    return prepared.toXDR();
  }

  /**
   * Submit an investor-signed inner transaction, wrapped in a **platform
   * fee-bump** so the platform pays the fee (the investor needs only USDC, not
   * XLM). A fee-bump does *not* consume the fee-source's sequence number — only
   * the inner tx's source (the investor) does — so concurrent investments never
   * contend on the platform account's sequence. Returns the submitted tx hash.
   */
  async submitSignedTransaction(signedXdr: string): Promise<{
    txHash: string;
    result: rpc.Api.GetSuccessfulTransactionResponse;
  }> {
    const platform = this.platform();
    const inner = TransactionBuilder.fromXDR(signedXdr, this.networkPassphrase);
    if (!(inner instanceof Transaction)) {
      throw new Error('Expected a signed inner transaction, got a fee-bump');
    }
    // baseFee = inner fee guarantees the fee-bump's total (baseFee × (ops+1))
    // clears the inner fee and the network minimum.
    const feeBump = TransactionBuilder.buildFeeBumpTransaction(
      platform,
      inner.fee,
      inner,
      this.networkPassphrase,
    );
    feeBump.sign(platform);
    const { result } = await this.sendAndPoll(feeBump);
    // Return the *inner* hash — stable across resubmits and what explorers show
    // for the investor's transaction (the fee-bump hash is the platform's).
    const txHash = inner.hash().toString('hex');
    this.logger.log(`Submitted investor tx (fee-bumped) inner tx ${txHash}`);
    return { result, txHash };
  }

  /** The transaction hash of a signed/unsigned tx XDR, hex-encoded. Stable across
   *  resubmits, so it doubles as an idempotency key for a client-submitted tx. */
  transactionHash(xdrString: string): string {
    const tx = TransactionBuilder.fromXDR(xdrString, this.networkPassphrase);
    return tx.hash().toString('hex');
  }

  /**
   * Decode the first `InvokeHostFunction` op of a (signed or unsigned) tx XDR
   * into its target contract, function name, and raw ScVal args — so callers can
   * verify a client-submitted tx really invokes the expected contract/function
   * before submitting it. Throws if the tx is not a contract invocation.
   */
  decodeInvokeContract(xdrString: string): {
    contractAddress: string;
    functionName: string;
    args: xdr.ScVal[];
  } {
    const tx = TransactionBuilder.fromXDR(xdrString, this.networkPassphrase);
    if (!(tx instanceof Transaction)) {
      throw new Error('Expected a transaction envelope, got a fee-bump');
    }
    const op = tx.operations[0];
    if (!op || op.type !== 'invokeHostFunction') {
      throw new Error('Transaction is not a contract invocation');
    }
    const ic = op.func.invokeContract();
    return {
      contractAddress: Address.fromScAddress(ic.contractAddress()).toString(),
      functionName: ic.functionName().toString(),
      args: ic.args(),
    };
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

  // ---- ScVal readers (inverse of the builders above) ----
  /** Read an ScVal `Address` back to its `G...`/`C...` string form. */
  readAddress(value: xdr.ScVal): string {
    return Address.fromScVal(value).toString();
  }
  /** Read an ScVal `i128` back to a bigint (stroops). */
  readI128(value: xdr.ScVal): bigint {
    return scValToNative(value) as bigint;
  }

  // ---- read-only (simulation) helpers — used by the ownership indexer ----

  /** The network's latest ledger sequence — used to seed the indexer cursor on a
   *  cold start (no signing, read-only). */
  async latestLedger(): Promise<number> {
    const { sequence } = await this.server.getLatestLedger();
    return sequence;
  }

  /**
   * Simulate a contract call read-only (no signing, no submit) and return the raw
   * ScVal it produced. Any source works for a read, so we use a synthetic account
   * (no network round-trip, no requirement that the platform account exist).
   */
  async simulateRead(
    contractId: string,
    func: string,
    args: xdr.ScVal[],
  ): Promise<xdr.ScVal> {
    const tx = new TransactionBuilder(
      new Account(this.platformPublicKey, '0'),
      {
        fee: this.fee,
        networkPassphrase: this.networkPassphrase,
      },
    )
      .addOperation(
        Operation.invokeContractFunction({
          contract: contractId,
          function: func,
          args,
        }),
      )
      .setTimeout(60)
      .build();

    const sim = await this.server.simulateTransaction(tx);
    if (!rpc.Api.isSimulationSuccess(sim) || !sim.result) {
      const detail = rpc.Api.isSimulationError(sim)
        ? sim.error
        : JSON.stringify(sim);
      throw new Error(`simulate ${contractId}.${func} failed: ${detail}`);
    }
    return sim.result.retval;
  }

  /** Read a ShareToken `balance(address)` as a bigint (stroops), read-only. This is
   *  the ownership source of truth — the indexer always re-reads it rather than
   *  decoding a value out of an event. */
  async readBalance(contractId: string, address: string): Promise<bigint> {
    const retval = await this.simulateRead(contractId, 'balance', [
      this.addressArg(address),
    ]);
    return this.readI128(retval);
  }

  /**
   * Fetch ShareToken events emitted by `contractIds` from `startLedger` onward,
   * transparently handling the RPC's 5-contract filter cap (chunking) and its page
   * `limit` (cursor pagination). Each returned {@link TokenEvent} carries only the
   * addresses appearing in the event topics; the merged `latestLedger` lets the
   * caller advance its cursor even when no events matched. Read-only.
   */
  async getContractEvents(
    contractIds: string[],
    startLedger: number,
  ): Promise<{ events: TokenEvent[]; latestLedger: number }> {
    const events: TokenEvent[] = [];
    let latestLedger = startLedger;

    for (
      let i = 0;
      i < contractIds.length;
      i += SorobanService.MAX_CONTRACT_FILTERS
    ) {
      const chunk = contractIds.slice(
        i,
        i + SorobanService.MAX_CONTRACT_FILTERS,
      );
      const filters: rpc.Api.EventFilter[] = [
        { type: 'contract', contractIds: chunk },
      ];
      let request: rpc.Api.GetEventsRequest = {
        filters,
        startLedger,
        limit: SorobanService.EVENTS_PAGE_LIMIT,
      };
      for (;;) {
        const res = await this.server.getEvents(request);
        for (const e of res.events) {
          events.push({
            contractId: e.contractId?.contractId() ?? '',
            addresses: this.addressesInTopics(e.topic),
            ledger: e.ledger,
          });
        }
        latestLedger = Math.max(latestLedger, res.latestLedger);
        if (
          res.events.length < SorobanService.EVENTS_PAGE_LIMIT ||
          !res.cursor
        ) {
          break;
        }
        request = {
          filters,
          cursor: res.cursor,
          limit: SorobanService.EVENTS_PAGE_LIMIT,
        };
      }
    }
    return { events, latestLedger };
  }

  /** The `C…`/`G…` addresses appearing in an event's topics (by ScVal type, so the
   *  leading `transfer`/`mint` symbol and any amount are ignored). */
  private addressesInTopics(topics: xdr.ScVal[]): string[] {
    const out: string[] = [];
    for (const topic of topics) {
      if (topic.switch() === xdr.ScValType.scvAddress()) {
        out.push(Address.fromScVal(topic).toString());
      }
    }
    return out;
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
    return this.sendAndPoll(prepared);
  }

  /** Send a signed tx and poll to a final status; throws unless SUCCESS. */
  private async sendAndPoll(tx: Transaction | FeeBumpTransaction): Promise<{
    result: rpc.Api.GetSuccessfulTransactionResponse;
    txHash: string;
  }> {
    const sent = await this.server.sendTransaction(tx);
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
