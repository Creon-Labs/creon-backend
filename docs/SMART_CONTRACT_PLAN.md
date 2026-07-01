# Creon — Smart Contract & On-Chain Integration Plan

> Phased implementation plan for the Soroban smart contracts and the backend ↔
> Stellar integration. Companion to [ARCHITECTURE.md](./ARCHITECTURE.md) (decisions)
> and [PROJECT.md](./PROJECT.md) (narrative). This document is the **build order**;
> keep it checked off as work lands.
>
> Last updated: 2026-07-01.

## Design summary (the decisions this plan implements)

These consolidate and, where noted, **refine** ARCHITECTURE.md:

1. **Contract topology — 1 singleton + 2 per-campaign** (simplified from 5 contracts):
   | Contract | Lifetime | Responsibility |
   |---|---|---|
   | `ComplianceRegistry` | **singleton** (1 per platform) | KYC whitelist: `add` / `remove` / `is_whitelisted`. Deployed once at platform setup. |
   | `ShareToken` (restricted SEP-41) | per-campaign | Share token; `mint` **and** `transfer` gated by the registry + lock flag. |
   | `Campaign` | per-campaign | **Merged vault + lifecycle + distribution**: `invest()`, USDC custody, lock/release, `deposit_profit`, `set_distribution(merkle_root)`, `claim(amount, proof)`. |

   > Refines ARCHITECTURE.md decisions #3/#7/#12: vault and distribution are **folded
   > into `Campaign`** to cut per-campaign deploys from 4 to **2 instances**. Split out
   > later only if a real need appears.

2. **Deploy orchestration — backend-orchestrated, async, idempotent. No factory.**
   On approval the backend submits N deploy txs in sequence via the SDK, driven by a
   DB state machine with retry. A factory contract is **deferred** (not worth its
   contract-side complexity at this scale).

3. **KYC whitelist — backend is the only writer.** On KYC approval the backend calls
   `registry.add(wallet)`; on expiry/sanction, `registry.remove(wallet)`. Because
   `mint`/`transfer` are gated on-chain, an unregistered wallet calling `invest()`
   directly is **reverted** — the website is the only path onto the whitelist.

4. **Ownership tracking — external indexer service, not a self-hosted worker.**
   We consume a managed Soroban indexer (e.g. Mercury / SubQuery / equivalent). The
   backend either **receives webhooks** or **queries** that service for share-token
   `transfer`/`mint`/`burn` events and maintains `TokenHolding` from that feed.

   > Supersedes ARCHITECTURE.md "Event Indexer (worker)" / decision #9 mechanics:
   > we do **not** run our own continuous `getEvents` ingestion worker. The
   > `TokenHolding` model and its role are unchanged; only the data source changes.

5. **Dividends — pull-based, Merkle-pinned (unchanged).** Backend snapshots
   `TokenHolding` at the deposit ledger, builds a Merkle tree, posts the root
   on-chain; investors `claim(amount, proof)` and the contract verifies the proof, so
   the backend cannot forge amounts.

---

## Phase 1 — Core smart contracts (Rust / Soroban)

**Goal:** all three contract types written, unit-tested, and deployable to Stellar
testnet. `ComplianceRegistry` live on testnet; `ShareToken` + `Campaign` WASM
uploaded (instantiated per-campaign in Phase 2).

**Deliverables**
- [x] `contracts/` Cargo workspace (repo subfolder) — standalone (kept out of the pnpm
      build); `cargo` + `stellar` CLI toolchain, shared workspace deps.
- [x] `ComplianceRegistry`: `add(addr)`, `remove(addr)`, `is_whitelisted(addr) -> bool`,
      owner-gated writes (OZ Ownable); typed events on add/remove.
- [x] `ShareToken` (restricted SEP-41 on OpenZeppelin `stellar-tokens` `Base`):
      `mint` requires recipient whitelisted (queries registry) and is minter-only;
      `transfer`/`transfer_from` require **recipient** whitelisted and are disabled while
      the lock flag is set; `set_minter` / `set_lock` admin path. (Shares are non-burnable.)
- [x] `Campaign` (merged): `__constructor(owner, token, registry, usdc, business, goal, lock_period)`;
      `invest(investor, amount)` (whitelist-gated → pull USDC into custody → mint shares 1:1);
      `release_to_business`/`unlock`; `deposit_profit(from, amount)`; `set_distribution(id, merkle_root)`;
      `claim(id, index, claimant, amount, proof)` with on-chain commutative SHA-256 Merkle verification.
- [x] Unit tests per contract (Soroban test env, 13 passing): whitelist gating at mint **and**
      transfer, lock behavior, invest happy-path + non-whitelisted revert, claim proof
      verify/forge-reject + double-claim.
- [x] Deployed `ComplianceRegistry` to testnet; uploaded `ShareToken` + `Campaign` WASM;
      recorded registry address + both `wasm_hash` values (see `contracts/deployments/testnet.json`).
- [x] Test USDC asset (SAC) set up on testnet.

**Acceptance:** ✅ verified on testnet — a non-whitelisted address calling `invest()` reverts; a
whitelisted one receives shares (via gated `mint`); a forged Merkle proof on `claim()` is rejected.
Registry `CCTB7KFSZCWSIB3UGYTSDO5PBWMTKD5XCDIEGIEAYVPZSH5K3S5RANQ7`; artifacts in `contracts/deployments/testnet.json`.

---

## Phase 2 — Backend ↔ Stellar integration & deploy orchestration

**Goal:** admin approval deploys a campaign's contracts automatically, idempotently,
and persists addresses + tx hashes.

**Design notes**
- Approval endpoint only sets status + **enqueues a deploy job** — never deploys
  inside the HTTP request.
- DB state machine, retry from the last successful step (idempotency keyed on the
  existing unique `tx_hash`):
  `APPROVED → DEPLOYING_TOKEN → DEPLOYING_CAMPAIGN → WIRING → LIVE`
  (deploy `ShareToken` → deploy `Campaign` → `token.set_minter(campaign)` → `LIVE`).

**Deliverables**
- [x] Stellar/Soroban SDK + RPC client wiring; platform signing key via `ConfigService`.
      (`src/soroban/SorobanService` — `deployFromWasmHash`, `invokeContract`, lazy
      platform `Keypair`; full `@stellar/stellar-sdk` allowlisted in jest transform.)
- [x] Config for registry address + `ShareToken`/`Campaign` `wasm_hash` (already in `.env.example`).
- [x] Deploy worker/job (instantiate from `wasm_hash` + salt, then wire). BullMQ on
      Valkey: `CampaignDeployProcessor` → idempotent `CampaignDeployService.drive`.
- [x] Persist `*_address` + `deploy_tx_hash` per step; resumable on failure. Added
      `ProjectToken.deployTxHash`, `Campaign.wireTxHash` (both `@unique`); resume point
      derived from persisted addresses; deterministic salt + on-chain pre-check avoid duplicates.
- [x] Campaign deploy state machine + status transitions on the `Campaign` model.
      New `CampaignDeployStatus` enum (`PENDING→DEPLOYING_TOKEN→DEPLOYING_CAMPAIGN→WIRING→LIVE`/`FAILED`);
      flips `CampaignStatus` to `ACTIVE` at `LIVE`.
- [x] Unit tests for the orchestrator (incl. partial-failure resume + queueing). The
      **deploy trigger** was also built: admin `POST /admin/proposals/:id/approve`
      (+ `reject`, `list`) creates the Campaign mirror and enqueues the deploy.
- [x] `onApplicationBootstrap` + periodic reconciler re-enqueue any not-yet-`LIVE` campaign.

**Acceptance:** approving a proposal results in a `LIVE` campaign with token +
campaign addresses persisted; killing the worker mid-deploy and restarting resumes
without orphaned/duplicate contracts. _(Implemented + unit-tested; on-chain e2e
pending a funded `STELLAR_PLATFORM_SECRET` on testnet.)_

**Depends on:** Phase 1.

---

## Phase 3 — KYC whitelist on-chain wiring

**Goal:** KYC approval/revocation reflected in `ComplianceRegistry` on-chain.

**Deliverables**
- [x] On admin KYC approve → enqueue `registry.add(wallet)`; persist tx hash + a
      whitelist status on `KycProfile`. Added `WhitelistStatus` enum + `whitelistStatus`,
      `whitelistTxHash`/`whitelistRemoveTxHash` (both `@unique`), `whitelistError`,
      `whitelistAttempts`. Approve only flips status + enqueues — never blocks on-chain.
- [x] Revocation path → `registry.remove(wallet)` (expiry / sanction). New
      `KycStatus.REVOKED` + `POST /admin/kyc/:userId/revoke` (asserts APPROVED → REVOKED → enqueue remove).
- [x] Idempotent + retryable (don't double-add; reconcile on `tx_hash`). BullMQ
      `kyc-whitelist` queue + `KycWhitelistService.drive` (desired state derived from KYC
      status; no-op once synced) + `onApplicationBootstrap`/`@Interval` reconciler. On-chain
      `add`/`remove` are themselves idempotent, so retries/double-enqueues are safe.
- [x] Tests for approve→add and revoke→remove (`kyc-whitelist.service.spec.ts` +
      extended `admin.service.spec.ts`; 94 unit tests green).

**Acceptance:** an approved user's wallet returns `true` from `is_whitelisted`
on-chain; a revoked one returns `false` and can no longer receive shares.
_(Implemented + unit-tested; on-chain e2e pending a funded `STELLAR_PLATFORM_SECRET` on testnet — same caveat as Phase 2.)_

**Depends on:** Phase 1 (registry live), Phase 2 (SDK wiring).

---

## Phase 4 — Investment flow

**Goal:** whitelisted investors fund a live campaign in USDC and receive shares.

**Signing model (decided):** **backend-prepares-XDR → investor-signs → backend-submits
(platform fee-bump).** `invest()` calls `investor.require_auth()` and pulls the investor's
USDC via a direct `transfer`, so the investor must sign — the platform key can't invest on
their behalf. Backend builds + simulates the tx with the **investor as source** (one signature
covers both the call and the inner USDC transfer), returns the XDR; the wallet signs; backend
wraps it in a **platform fee-bump** (so the investor needs only USDC, not XLM) and submits.
A fee-bump does not consume the platform's sequence number, so this stays **synchronous** with
no queue. Verification + recording is idempotent on the stable inner tx hash.

**Deliverables**
- [x] Investments module: invest into a campaign (whitelisted/KYC'd only, `ApprovedInvestorGuard`),
      list-per-investor (`GET /investments/mine`), campaign list/detail (`CampaignController`:
      public `GET /campaigns`, `GET /campaigns/:id`). (`src/investment/`, `src/campaign/campaign.controller.ts`.)
- [x] Backend path to relay the `invest()` interaction: `POST /campaigns/:id/investments/prepare`
      returns the unsigned XDR; `POST /campaigns/:id/investments` verifies + fee-bumps + submits the
      signed tx. New `SorobanService` primitives: `buildInvokeTransaction`, `submitSignedTransaction`
      (fee-bump), `decodeInvokeContract`, `transactionHash`, `readAddress`/`readI128`.
- [x] Persist `Investment` rows (CONFIRMED, `txHash` = inner hash, `lpTokens` = amount at 1:1 mint);
      bump `Campaign.raisedAmount` + `CampaignVault.totalDeposited` in one transaction.
- [x] DTOs + validation + tests (`prepare`/`submit`/`listMine` branches, verification failures,
      idempotency, `ApprovedInvestorGuard`, campaign reads).

**Acceptance:** a whitelisted investor invests USDC and the campaign vault balance +
their `ShareToken` balance increase; a non-whitelisted attempt is rejected on-chain.
_(Implemented + unit-tested; on-chain e2e pending a funded `STELLAR_PLATFORM_SECRET` + a
whitelisted investor account with test USDC — same caveat as Phases 2–3.)_

**Depends on:** Phases 1–3.

---

## Phase 5 — Ownership tracking via external indexer

**Goal:** maintain `TokenHolding` (current balances) from a managed indexer, since
SEP-41 is not enumerable on-chain — **without** running our own ingestion worker.

**Design notes**
- Choose the provider (Mercury / SubQuery / equivalent) and the mode:
  **webhook push** (preferred) and/or **API query/poll** as fallback.
- Backend's job is reconciliation into `TokenHolding`, not raw ingestion.

**Deliverables**
- [ ] Select indexer provider + subscribe to `ShareToken` transfer/mint/burn events.
- [ ] Webhook receiver endpoint (verify signature/secret; idempotent on event id).
- [ ] Reconcile events → upsert `TokenHolding` by `(campaignId, holderAddress)`.
- [ ] Backfill/query path for gaps or initial sync.
- [ ] Tests for webhook handling + holding reconciliation.

**Acceptance:** after on-chain transfers, `TokenHolding` matches on-chain balances
for a campaign within the indexer's delivery latency.

**Depends on:** Phase 1 (token deployed), Phase 4 (real transfers to observe).

---

## Phase 6 — Dividend distribution (Merkle)

**Goal:** business deposits profit; investors claim pro-rata dividends, enforced
on-chain via a Merkle root.

**Deliverables**
- [ ] On `deposit_profit` (observed via the indexer) → fix snapshot ledger; read
      `TokenHolding` at that ledger.
- [ ] Compute pro-rata entitlements; build Merkle tree + root; persist
      `ProfitDistribution` + per-holder `DistributionClaim` (with `merkleProof`).
- [ ] Post `set_distribution(id, merkle_root)` on-chain.
- [ ] API: list entitlements, fetch proof, mark claimed (driven by indexer `claim` events).
- [ ] Unclaimed-dividend policy (rollover vs return) + claim window.
- [ ] Tests for snapshot math, tree/root, and claim status reconciliation.

**Acceptance:** a deposited profit yields claimable entitlements; an investor's
`claim(id, amount, proof)` succeeds and is marked `CLAIMED`; total claims are bounded
by the deposited amount.

**Depends on:** Phases 1–5.

---

## Build order rationale

Riskiest / most foundational first: **Phase 1 proves KYC gating on-chain**, and
**Phases 1–4 are enough for a demo** ("approve → campaign live → whitelisted investor
invests, non-KYC rejected on-chain"). Phases 5–6 complete the dividend (bagi hasil)
story.
