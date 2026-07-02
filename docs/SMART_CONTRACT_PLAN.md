# Creon — Smart Contract & On-Chain Integration Plan

> Phased implementation plan for the Soroban smart contracts and the backend ↔
> Stellar integration. Companion to [ARCHITECTURE.md](./ARCHITECTURE.md) (decisions)
> and [PROJECT.md](./PROJECT.md) (narrative). This document is the **build order**;
> keep it checked off as work lands.
>
> Last updated: 2026-07-02.

## Design summary (the decisions this plan implements)

These consolidate and, where noted, **refine** ARCHITECTURE.md:

1. **Contract topology — 1 singleton + 2 per-campaign** (simplified from 5 contracts):
   | Contract | Lifetime | Responsibility |
   |---|---|---|
   | `ComplianceRegistry` | **singleton** (1 per platform) | KYC whitelist: `add` / `remove` / `is_whitelisted`. Deployed once at platform setup. |
   | `ShareToken` (restricted SEP-41) | per-campaign | Share token; `mint` **and** `transfer` gated by the registry + lock flag. |
   | `Campaign` | per-campaign | **Merged vault + lifecycle + distribution**: `invest()`, USDC custody, lock/release, staged `release_milestone(index)`, `deposit_profit`, `set_distribution(merkle_root)`, `claim(amount, proof)`. |

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

4. **Ownership tracking — self-hosted polling loop, no third-party indexer.**
   A single `@Interval` job polls Soroban RPC's `getEvents` for each `LIVE` campaign's
   `ShareToken` contract, using the events only to detect *which* addresses changed —
   the balance actually written to `TokenHolding` is always a fresh on-chain
   `balance()` read (source of truth, avoids amount-decoding bugs), not a value parsed
   out of the event. The last processed ledger is a single cursor kept in Valkey via
   `CacheService`, not a DB migration.

   > Reinstates (in simplified form) ARCHITECTURE.md's "Event Indexer (worker)" /
   > decision #9 mechanics: for hackathon scope, a self-hosted poll beats onboarding a
   > managed indexer (Mercury / SubQuery / Goldsky) — no external account/billing, and
   > RPC's 7-day event retention is a non-issue for a service kept continuously running.
   > The `TokenHolding` model and its role are unchanged.

5. **Dividends — pull-based, Merkle-pinned (unchanged).** Backend snapshots
   `TokenHolding` at the deposit ledger, builds a Merkle tree, posts the root
   on-chain; investors `claim(amount, proof)` and the contract verifies the proof, so
   the backend cannot forge amounts.

6. **Fund release — milestone-based staged release, hybrid on-/off-chain (added
   2026-07-02, see Phase 7).** Lump-sum `release_to_business` is replaced by
   `release_milestone(index)`: per-milestone amounts are **pinned on-chain**
   (`Vec<i128>` at deploy, summing to the goal) and released sequentially, once
   each, only once the campaign is **fully funded**. *Which* milestone releases and
   *when* is decided by **fully off-chain** investor voting (Postgres) weighted by
   share balance — quorum (of snapshotted total supply) + majority of cast weight,
   with a missed-quorum window extended once and then defaulted to approved so a
   passive electorate can't stall a legitimate business.

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
      **Superseded in Phase 7:** the constructor gained a trailing `milestone_amounts:
      Vec<i128>` param and `release_to_business` was replaced by staged
      `release_milestone(index)`.
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

## Phase 5 — Ownership tracking via a self-hosted polling loop

**Goal:** maintain `TokenHolding` (current balances) by polling Soroban RPC directly,
since SEP-41 is not enumerable on-chain — no third-party indexer, no webhooks.

**Design notes**
- One periodic job, not a BullMQ per-entity state machine like `campaign-deploy`/
  `kyc-whitelist` — there's no per-entity retry semantics here, just a continuous
  cursor-based loop, so a plain `@Interval` + `onApplicationBootstrap` service is enough
  (no queue/processor).
- `SorobanService` gains a `getEvents` wrapper (filtered by the `ShareToken`
  `contractIds` of all `LIVE` campaigns) and a read-only `balance(address)` wrapper.
- The cursor (last processed ledger) lives in Valkey via `CacheService`, not a new
  table/column — no migration needed for this phase.
- Events are used only to find *which* addresses changed on a given poll; the balance
  written to `TokenHolding` always comes from a fresh on-chain `balance()` read, never
  from decoding the event's amount — so a mis-decoded event can't corrupt the ledger.
- RPC's `getEvents` retention is 7 days; a non-issue for a loop kept continuously
  running — a restart just resumes from the last saved cursor (small lookback if the
  cursor is missing).

**Deliverables**
- [x] `SorobanService.getContractEvents` — wraps `rpc.Server.getEvents`, chunking the
      LIVE-token set to the RPC's 5-contract cap and paginating each chunk on its cursor;
      returns `{ events, latestLedger }`, each event reduced to the addresses in its topics
      (amounts dropped). Plus `latestLedger()` (cursor seed).
- [x] `SorobanService.readBalance` (via read-only `simulateRead` + `readI128`) — read-only
      `balance(address)` call against a `ShareToken` contract, no signing/submit.
- [x] `TokenHoldingIndexerService` (new, `src/indexer/`): `@Interval` poll loop +
      `onApplicationBootstrap`; reads/writes the ledger cursor in `CacheService`; queries
      `LIVE` campaigns for the set of `ShareToken` addresses to filter on. Plain service (no
      BullMQ) with an in-flight guard; the cursor only advances on a fully successful poll.
- [x] Reconcile events → for each touched `(campaignId, holderAddress)`, fresh `balance()`
      read → upsert `TokenHolding` (unique on `campaignId, holderAddress`); `holderId`
      resolved from `walletAddress` (null for unregistered addresses).
- [x] Backfill path for first run / gaps: on a missing cursor, seed from
      `latestLedger − INDEXER_LOOKBACK_LEDGERS` (configurable, default ~1 day).
- [x] Tests for the poll loop (event → balance → upsert), dedupe, cursor persistence,
      cold-start seeding, and no-advance-on-failure behavior (`token-holding-indexer.service.spec.ts`
      + extended `soroban.service.spec.ts`).

**Acceptance:** after an on-chain transfer/investment, `TokenHolding` matches the
contract's real `balance()` for the affected addresses within one poll interval.
_(Implemented + unit-tested; on-chain e2e pending a funded `STELLAR_PLATFORM_SECRET` +
real transfers to observe — same caveat as Phases 2–4.)_

**Depends on:** Phase 1 (token deployed), Phase 4 (real transfers to observe).

---

## Phase 6 — Dividend distribution (Merkle)

**Goal:** business deposits profit; investors claim pro-rata dividends, enforced
on-chain via a Merkle root.

**Design notes (refines the original sketch, decided during build)**
- **Deposit is a relay, not indexer-observed.** The business deposits via a
  prepare/submit-XDR flow that mirrors invest (`deposit_profit()` needs the
  depositor's own auth), so a successful submit creates the `ProfitDistribution`
  synchronously and pins `snapshotLedger` from the tx result — no dependency on the
  indexer catching a `ProfitDeposited` event.
- **Snapshot + root post is a BullMQ orchestrator** (`distribution` queue), the same
  idempotent/resumable shape as `campaign-deploy`/`kyc-whitelist`. Resume points are
  derived from persisted data (claims built? root posted?).
- **Claims are recorded by the submit endpoint** (idempotent on the unique
  `claim_tx_hash`); no indexer `claim`-event reconciliation for now.
- **Unclaimed dividends stay claimable indefinitely** — the contract has no reclaim
  path, so there is no claim window / return-to-business (documented, not built).
- On-chain leaf/Merkle encoding is pinned to a Rust-emitted test vector
  (`print_merkle_test_vector` in `contracts/campaign/src/test.rs`).

**Deliverables**
- [x] Entrepreneur `deposit_profit()` relay (`POST campaigns/:id/distributions/deposit`
      prepare + submit) → creates `ProfitDistribution` (PENDING), pins snapshot ledger,
      enqueues the orchestrator. New `ProfitDistribution.onchainId` (per-campaign `u32`),
      `setDistributionTxHash`, `distributionError/Attempts`, `DistributionStatus.FAILED`.
- [x] `DistributionOrchestratorService.drive`: snapshot registered `TokenHolding`
      (balance > 0), compute integer-floor pro-rata entitlements, build the Merkle tree
      + root (`src/distribution/merkle.util.ts`), persist per-holder `DistributionClaim`
      (with `leafIndex` + `merkleProof`) in one transaction.
- [x] Post `set_distribution(id, merkle_root)` on-chain (owner/platform-signed);
      idempotent (skips if `setDistributionTxHash` set; tolerates `DistributionExists`).
- [x] API: `GET distributions/mine` (entitlements + proofs), claim relay
      (`POST distributions/:id/claim` prepare + submit) marks `DistributionClaim`
      CLAIMED + bumps `totalClaimed`; `GET campaigns/:id/distributions`.
- [x] Unclaimed-dividend policy: **claimable indefinitely** (no on-chain reclaim /
      claim window — the contract has no reclaim function).
- [x] Tests: leaf/tree/root vs the on-chain vector, snapshot math (floor, Σ ≤ total),
      resume paths, `DistributionExists` tolerance, claim verify + idempotency
      (`merkle.util.spec.ts`, `distribution-orchestrator.service.spec.ts`,
      `distribution.service.spec.ts`).

**Acceptance:** a deposited profit yields claimable entitlements; an investor's
`claim(id, amount, proof)` succeeds and is marked `CLAIMED`; total claims are bounded
by the deposited amount (the backend builds a tree whose leaf amounts sum to ≤ the
deposit). _(Implemented + unit-tested; on-chain e2e pending a funded
`STELLAR_PLATFORM_SECRET` + a whitelisted holder to observe — same caveat as Phases 2–5.)_

**Depends on:** Phases 1–5.

---

## Phase 7 — Milestone-based staged fund release (hybrid)

**Goal:** replace lump-sum `release_to_business` with per-milestone staged release,
gated by off-chain investor voting weighted by share balance.

**Design notes (decided during build, 2026-07-02)**
- **Hybrid split**: milestone amounts are pinned **on-chain** (`Vec<i128>` at
  constructor, must sum to the goal); voting itself is **fully off-chain**
  (Postgres) — the contract doesn't know about votes, only enforces
  sequential/once-only release (a `NextMilestone` counter) and a full-funding gate.
- **All-or-nothing funding**: `release_milestone` reverts unless `raised >= goal`.
- **Quorum + majority**: participation quorum is measured against a snapshot of
  total supply (Σ `TokenHolding.balance` at the moment voting opens — **not**
  `ProjectToken.totalSupply`, which is never populated) plus a strict majority of
  cast weight. Both thresholds are configurable via env.
- **Quorum-miss handling**: extend the voting window once; if still unmet,
  default-approve (a passive electorate can't deadlock a legitimate business).
- **No dates in milestone authoring** — release is event-triggered (the
  entrepreneur clicks submit), not scheduled.
- A **fourth BullMQ orchestrator** (`milestone-release`), same idempotent
  `drive()`/reconcile shape as `campaign-deploy`/`kyc-whitelist`/`distribution`; the
  contract's `NextMilestone` counter makes a duplicate `release_milestone` call
  revert with `MilestoneOutOfOrder`, which the orchestrator treats as "already
  released" to finalize idempotently.

**Deliverables**
- [x] Contract: constructor gains `milestone_amounts: Vec<i128>` (validated
      `sum == goal`); `release_to_business` replaced by `release_milestone(index)`
      (owner-gated, sequential via the `NextMilestone` counter, gated on
      `raised >= goal`); new errors `MilestoneSumMismatch`/`FundingIncomplete`/
      `MilestoneOutOfOrder`; event `MilestoneReleased`. Tests: sequential release,
      out-of-order revert, pre-funding revert, double-release revert, constructor
      sum-mismatch revert (`contracts/campaign/src/lib.rs`, `test.rs`).
- [x] Schema: `Milestone` + `MilestoneVote` models, `MilestoneStatus`/`VoteChoice`
      enums (migration `20260702080530_add_milestones`).
- [x] Proposal authoring: nested `milestones` array on create/update proposal DTOs;
      the service validates contiguous `order` + Σ`amount` == `requestedAmount`
      (stroop-exact); milestones are linked to the campaign at approval.
- [x] Deploy: `CampaignDeployService` passes the milestone amounts `Vec`
      (`i128VecArg`, a new `SorobanService` helper) as the constructor's last arg.
- [x] Voting module (`src/milestone/`): entrepreneur `submitForRelease` (ownership +
      full-funding + sequential gate + proof upload + supply snapshot), investor
      `vote` (weight = `TokenHolding.balance`, upsert), `settleExpired` reconcile
      (`@Interval` + boot) tallying quorum/majority, extend-once-then-default-approve.
- [x] Release orchestrator (4th BullMQ queue `milestone-release`): mirrors
      `campaign-deploy`; drives `APPROVED → RELEASING → RELEASED`, bumps
      `CampaignVault.releasedToBusiness`.
- [x] Config: `MILESTONE_VOTING_WINDOW_SECONDS` (7d), `MILESTONE_QUORUM_BPS` (30%),
      `MILESTONE_APPROVAL_BPS` (>50%).
- [x] Tests: contract (11 total, all green), backend unit (`milestone.util`,
      `milestone-release.service`, `milestone-voting.service`, plus
      `proposal`/`campaign`/`campaign-deploy` extensions) — 199 backend tests green.

**Acceptance:** a campaign funded to goal, with a milestone submitted and approved
by investor vote (or defaulted after a missed-quorum extension), has its
`release_milestone(index)` tx succeed and `CampaignVault.releasedToBusiness`
increase by that milestone's amount; a second submit for the same index is rejected
until the next milestone is reached. _(Implemented + unit-tested; on-chain e2e
pending the same funded `STELLAR_PLATFORM_SECRET` caveat as Phases 2–6, **plus** a
WASM rebuild + redeploy since the constructor signature changed — see below.)_

**Outstanding before e2e**: the constructor signature changed (new
`milestone_amounts` param), so the WASM must be rebuilt (`stellar contract build`)
and redeployed, and `CAMPAIGN_WASM_HASH` + `contracts/deployments/testnet.json`
updated. Deploy is per-campaign, so campaigns already live on testnet keep working
under the old WASM — only new deploys pick up the milestone feature.

**Depends on:** Phases 1–4 (a funded, live campaign to attach milestones to).

---

## Build order rationale

Riskiest / most foundational first: **Phase 1 proves KYC gating on-chain**, and
**Phases 1–4 are enough for a demo** ("approve → campaign live → whitelisted investor
invests, non-KYC rejected on-chain"). Phases 5–6 complete the dividend (bagi hasil)
story; Phase 7 replaces lump-sum disbursement with milestone-gated staged release.
