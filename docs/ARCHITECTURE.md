# Creon — Architecture Decisions & Build Roadmap

> Technical companion to [PROJECT.md](./PROJECT.md). It records the **decisions**
> made for the backend data & on-chain value model, and the **checklist of what
> still needs to be built**. Keep it up to date as decisions change or work lands.
>
> The **phased build order** for the contracts + on-chain integration lives in
> [SMART_CONTRACT_PLAN.md](./SMART_CONTRACT_PLAN.md). That plan refines two
> mechanics recorded here: the per-campaign contracts are **merged** (vault +
> distribution folded into `Campaign` — see #7), and ownership tracking uses an
> **external indexer service** rather than a self-hosted worker (see #9).
>
> Last updated: 2026-07-03.

## Status at a glance

- ✅ **Persistence foundation** — Prisma 7 + PostgreSQL schema (15 models + 15
  enums), migrations, global `PrismaModule`, docker-compose Postgres + Valkey +
  MinIO, seed. See `prisma/schema.prisma` and `src/prisma/`.
- ✅ **Wallet auth + KYC / admin approval + proposals** — challenge/signature JWT
  auth, role-agnostic KYC, admin review, entrepreneur proposal lifecycle. See
  `src/auth/`, `src/kyc/`, `src/admin/`, `src/proposal/`.
- ✅ **On-chain integration through campaign deploy** — Soroban contracts live on
  testnet (`contracts/`); on proposal approval the backend deploys a per-campaign
  token + campaign and syncs the KYC whitelist — both idempotent BullMQ
  orchestrators (`src/soroban/`, `src/campaign/`, `src/kyc/kyc-whitelist.*`).
- ⏳ **Not yet built** — the ownership indexer feed (`TokenHolding`), investment
  recording, and the dividend snapshot / Merkle distribution service. See the
  [roadmap](#build-roadmap).

---

## Architecture decisions

| # | Decision | Why | Status |
|---|----------|-----|--------|
| 1 | **Prisma + PostgreSQL** as ORM/DB | Type-safe, fast migrations; Postgres fits financial data | ✅ Implemented |
| 2 | **Wallet-based identity** (Stellar public key); email optional | Web3 product — wallet is the natural identity | ✅ Implemented (challenge/signature JWT auth, `src/auth/`) |
| 3 | **Share = restricted SEP-41 token** (permissioned). Holding is gated by a whitelist: **both `mint` (invest) and `transfer` require the recipient to be whitelisted**; non-transferable during lock, whitelist-only transfers after unlock | Programmable lock/transfer rules (classic assets only allow coarse auth flags); gating at mint **and** transfer is the only way KYC can't be bypassed by P2P-sending shares to an unregistered wallet; reuses a token standard instead of a hand-rolled percentage ledger | ✅ `ShareToken` built (Phase 1, testnet) |
| 4 | **Returns via dividends / bagi hasil** (NOT buyback) | Transparent & easy to value for retail UMKM investors; value is conserved (can't both pay cash and inflate price from the same profit) | ✅ Schema supports it |
| 5 | **Pull-based distribution** (investors `claim()`, not push) | Pushing payouts in a loop is gas-heavy and a DoS risk; pull scales and is safe | ✅ Schema supports it |
| 6 | **Entitlement via Merkle snapshot** (NOT an accumulator/transfer-hook token) | After unlock holders change, so ownership must be pinned to a moment. Backend snapshots balances off-chain, posts a **merkle root** on-chain; claims verify against it → trust-minimized, and the token stays standard SEP-41 | 🟡 On-chain `claim` proof-verification built (Phase 1); backend snapshot service ⏳ |
| 7 | **Custody via Vault/Escrow** (NOT an AMM pool); vault + distribution **folded into the `Campaign` contract** | An AMM is redundant in a dividend model and contradicts crowdfunding — exit liquidity would require parking the very USDC that must go to the business. Merging cuts per-campaign deploys from 4 to 2 instances (see SMART_CONTRACT_PLAN.md #1) | ✅ `CampaignVault` model + merged `Campaign` contract built (Phase 1, testnet) |
| 8 | **Lifecycle Model A** — periodic dividends allowed **during** the lock | Lock secures the *principal* + token *transferability*, not profit-sharing; business can share profit while capital stays locked | ✅ Schema supports it |
| 9 | **Ownership tracked in `TokenHolding`** (fed by an **external indexer service** — webhook/query, not a self-hosted worker) | SEP-41 is **not enumerable on-chain** (like ERC-20). After unlock, `Investment` ≠ current ownership; a managed Soroban indexer (Mercury/SubQuery/equivalent) feeds holdings from transfer/mint/burn events so we don't run continuous `getEvents` ingestion ourselves | ⏳ Integration not built |
| 10 | **Money precision** `Decimal(28,7)`; `rewardPerShare` `Decimal(38,18)` | Matches Stellar's 7 decimals; extra precision on the per-share accumulator avoids rounding drift | ✅ Implemented |
| 11 | **Prisma 7 + driver adapter** (migrated up from `^6`) | Prisma 7 drops `url = env()`; needs a `PrismaPg` adapter, `prisma.config.ts`, and the `prisma-client` generator (output to `generated/prisma`). Migrated once the setup was proven | ✅ Implemented (7.8) |
| 12 | **Shared `ComplianceRegistry` contract** (singleton) holds the single whitelist; every share token queries it (not a per-token list) | One KYC → whitelisted for all campaigns; one place for the backend to add/revoke; gives a home for revocation (expired KYC / sanctions) | ✅ Built (Phase 1, testnet) |
| 13 | **Deploy orchestration is backend-driven, async + idempotent — no factory contract** | On approval the backend submits N deploy txs in sequence via a DB state machine (`PENDING → DEPLOYING_TOKEN → DEPLOYING_CAMPAIGN → WIRING → LIVE`), resumable on partial failure (idempotent on the unique `tx_hash` + deterministic salt). A factory adds contract-side complexity not worth it at this scale | ✅ Built (BullMQ on Valkey; `CampaignDeployService` + `CampaignDeployStatus` enum; admin approval is the trigger) |
| 14 | **Investor onboarding mirrors the entrepreneur flow**: wallet register → KYC → backend whitelists the address; `invest()` is whitelist-gated on-chain | Securities crowdfunding (OJK SCF) requires KYC'd investors; gating in the contract means an unregistered wallet that calls `invest()` directly is *rejected*, not merely discouraged | ✅ Register + KYC (shared role-agnostic `KycProfile`) + on-chain whitelist sync built (`src/kyc/kyc-whitelist.*`, BullMQ: approve→`registry.add`, revoke→`registry.remove`) |
| 15 | **Refunds via a dedicated on-chain path** (admin-cancel → freeze → pro-rata of the *remaining* custody), **not** a reuse of the dividend distribution | A funded campaign can turn out fraudulent or fail to deliver; investors need their principal back. A distinct `cancel()` / `set_refund()` / `refund_claim()` path (reusing the Merkle machinery) lets cancel **freeze** `invest()` + `release_milestone()` — the load-bearing safety property a dividend can't express — while refunding only what is still in custody (`raised − released`), so it is always executable even after milestones paid the business | ✅ Built (contract path + `src/refund/` BullMQ orchestrator + admin cancel; on `dev`, **pending WASM redeploy**) |

### Key distinction to remember: what "lock" actually locks
Lock applies to **(a) withdrawing principal** and **(b) transferring the share
token** — **not** to receiving dividends. Dividends (`ProfitDistribution` /
`DistributionClaim`) can flow during the lock and continue after unlock. After
unlock the pool's only role would be exit/secondary market (we deferred the AMM),
so exit is via P2P token transfer to whitelisted addresses.

### Permissioned token: who may hold a share, and why invest is gated

On a public chain anyone can *broadcast* a transaction; access control is whatever
the contract *enforces*. Because Creon is securities-like (OJK SCF), **every address
that holds a share token must be KYC'd**. We enforce this at two choke points, both
checking a shared **`ComplianceRegistry`**:

- **`invest()` / `mint`** — minting shares to an investor requires that investor's
  wallet to be whitelisted. An unregistered wallet calling `invest()` directly is
  **reverted**, so the website (register + KYC) is the *only* path onto the whitelist.
- **`transfer`** — the **recipient** must be whitelisted (and during lock, transfer
  is disabled entirely). This closes the back door where a KYC'd holder hands shares
  to an unregistered wallet.

Net effect: a share token can never land in a non-KYC'd address, whether by mint or
transfer. This is the Soroban equivalent of a permissioned security token
(cf. ERC-3643 / ERC-1404). Consequences:

- There is **no open secondary market** — exit is P2P transfer between whitelisted
  addresses only (an AMM pool would itself have to be whitelisted to hold the token;
  part of why the AMM is deferred — Decision #7).
- **Revocation** is real: removing an address from the registry (expired KYC /
  sanctions) immediately blocks it from receiving more shares.
- Dividend *receipt* is **not** gated, but since only whitelisted addresses can hold
  shares, every holder in a snapshot is already KYC'd.

---

## Data model (implemented)

15 models in `prisma/schema.prisma`:

```
User ──┬─ kycProfile (1:1, role-agnostic)  Proposal ─┬─1:1──> Campaign
       ├─ proposals (entrepreneur)                    │          ├─1:1──> ProjectToken   (isTransferable = lock flag)
       ├─ reviews   (admin)                           │          ├─1:1──> CampaignVault  (custody + lock + release)
       ├─ investments                                 │          ├─1:1──> Refund ──1:N──> RefundClaim  (opened on cancel)
       ├─ holdings (TokenHolding)                     │          ├─1:N──> Investment     (lpTokens = pro-rata basis)
       ├─ distributionClaims                          │          ├─1:N──> TokenHolding   (current ownership, from indexer)
       ├─ refundClaims                                │          └─1:N──> ProfitDistribution ─1:N─> DistributionClaim
       └─ milestoneVotes                              ├─1:N──> ProposalReview (approval audit trail)
                                                      └─1:N──> Milestone ──1:N──> MilestoneVote  (campaignId set at approval)
```

`KycProfile` also carries the on-chain whitelist-sync state (`whitelistStatus` +
tx hashes); `Campaign` carries the deploy state machine (`deployStatus`,
`deploy_tx_hash`, `wire_tx_hash`).

The DB is an **off-chain mirror** of on-chain state: it stores contract addresses
+ tx hashes, with `tx_hash` unique for idempotent reconciliation.

---

## Dividend distribution flow (Merkle snapshot)

The target flow once the on-chain pieces exist:

```
1. Business earns profit → deposit_profit(USDC) to the Distribution contract
        └─ contract emits ProfitDeposited(campaign, amount, ledger)
2. External indexer delivers the event → fix the SNAPSHOT LEDGER (= deposit ledger)
        └─ read TokenHolding at that ledger → { address, shareAmount }
3. Backend computes each holder's entitlement = amount × shareAmount / totalShares
        └─ build a Merkle tree of (address, entitlement) → merkle root
4. Backend posts set_distribution(id, merkleRoot) to the contract
        └─ persist ProfitDistribution { amount, totalShares, merkleRoot, snapshotLedger }
        └─ persist DistributionClaim (PENDING) per holder { shareAmount, amount, merkleProof }
5. Investor calls claim(id, amount, merkleProof) → contract verifies proof → USDC released
        └─ indexer marks the claim CLAIMED + records claim_tx_hash
6. Leftover after a claim window → policy: rollover to next distribution / return to business (TBD)
```

Why merkle: entitlement must be enforced **on-chain**, not just trusted from the
DB. The contract verifies each proof against the root, so the backend cannot forge
amounts, and total claims are bounded by the deposited amount.

---

## Refund flow (campaign cancellation)

When a funded campaign turns out to be fraudulent or fails to deliver, an admin
cancels it and investors pull back their pro-rata share of whatever USDC is **still in
custody**. This reuses the dividend Merkle machinery, but the pot is the *remaining
custody* (not a fresh deposit) and cancel **freezes** the contract:

```
1. Admin POST /admin/campaigns/:id/cancel {reason}
        └─ one DB tx: Campaign → CANCELLED + open Refund (PENDING) → enqueue orchestrator
2. Orchestrator: cancel() on-chain
        └─ freezes invest() + release_milestone() (both now revert CampaignCancelled)
3. Snapshot TokenHolding; pot = raised − released (read on-chain, not the DB mirror)
        └─ integer-floor pro-rata by shares ⇒ Σ refunds ≤ actual custody (dust stays)
        └─ build a refund Merkle tree → persist one RefundClaim per holder
4. Orchestrator: set_refund(root) on-chain → Refund COMPLETED (claimable)
5. Investor: refund_claim(index, addr, amount, proof) via prepare→sign→submit relay
        └─ contract verifies the proof → USDC principal returned → RefundClaim CLAIMED
```

Why a *dedicated* path rather than reusing `set_distribution`: the load-bearing
property is the **freeze** — once cancelled, no new money in and no more principal out
to the business — which a dividend distribution cannot express. Refunding only the
*remaining* custody keeps it always executable even when milestones already paid the
business (investors get <100% in that case — honest about on-chain reality). Shares are
**not** burned (a CANCELLED campaign runs no further dividends/milestones, so it is
harmless — noted as optional hardening). Unclaimed refunds stay claimable indefinitely
(no on-chain reclaim path). The orchestrator is the **4th** BullMQ orchestrator and
follows the same idempotent/resumable shape (resume points derived from `cancelTxHash`
/ claims-exist / `setRefundTxHash`, not the status column alone).

---

## System components beyond the database

```
External indexer service ──transfer/mint/burn/claim events──► Backend (webhook receiver / query)
   (Mercury / SubQuery /                                           │
    equivalent)                                                    └─► TokenHolding (current balances) ──► dividend snapshot
```

Ownership feed is **load-bearing infra**, not optional: SEP-41 has no on-chain
holder enumeration, and Soroban RPC event retention is short (a few days). Rather
than run our own continuous ingestion worker, we subscribe to a **managed Soroban
indexer** and the backend reconciles its events into `TokenHolding` (webhook push
preferred, API query/poll as fallback). See SMART_CONTRACT_PLAN.md Phase 5.

---

## Build roadmap

What still needs to be built, grouped by area. Check items off as they land.

### A. Soroban smart contracts
> Topology = 1 singleton + 2 per-campaign (vault + distribution folded into `Campaign`).
> See SMART_CONTRACT_PLAN.md Phase 1 for the detailed contract checklist.
- [x] **`ComplianceRegistry` contract** (singleton) — single source-of-truth whitelist (`add` / `remove` / `is_whitelisted`); queried by share tokens at mint + transfer. _(Phase 1; live on testnet.)_
- [x] **Restricted SEP-41 share token** (`ShareToken`, per-campaign) — **`mint` and `transfer` both gated** by lock period + whitelist (KYC); recipient must be whitelisted. Built on OpenZeppelin `stellar-tokens`. _(Phase 1; WASM uploaded.)_
- [x] **`Campaign` contract** (per-campaign, merged vault + distribution) — lifecycle + `invest()` (whitelist-gated mint), USDC custody + lock/release, and `deposit_profit` / `set_distribution(merkleRoot)` / `claim(amount, proof)` with on-chain proof verification. _(Phase 1; WASM uploaded.)_
- [x] Test USDC asset setup on Stellar testnet. _(SAC deployed; see `contracts/deployments/testnet.json`.)_

### B. On-chain integration (backend ↔ Stellar)
- [x] Stellar SDK / Soroban RPC client wiring + signing for platform-side txs. (`src/soroban/SorobanService`.)
- [x] Deploy orchestration: on approval → deploy token + campaign, wire minter, persist contract addresses + `deploy_tx_hash`/`wire_tx_hash`. (`src/campaign/`; BullMQ on Valkey.)
- [x] Idempotent reconciliation keyed on `tx_hash` (schema enforces uniqueness) + deterministic salt + on-chain pre-check.

### C. Ownership feed (external indexer service)
> See SMART_CONTRACT_PLAN.md Phase 5. We consume a managed indexer; no self-hosted worker.
- [ ] Select indexer provider (Mercury / SubQuery / equivalent) + subscribe to share-token transfer/mint/burn + distribution events.
- [ ] Webhook receiver endpoint (verify secret/signature; idempotent on event id), with API query/poll as backfill fallback.
- [ ] Reconcile events → maintain `TokenHolding` (upsert balances by `(campaignId, holderAddress)`).
- [ ] Update `Investment` / `ProfitDistribution` / `DistributionClaim` statuses from indexed events.

### D. Dividend / Merkle distribution service
- [ ] On `ProfitDeposited`: snapshot `TokenHolding` at the deposit ledger.
- [ ] Compute pro-rata entitlements; build Merkle tree + root; persist `ProfitDistribution` + per-holder `DistributionClaim` (with `merkleProof`).
- [ ] Post the root on-chain; expose proofs to the frontend for claiming.
- [ ] Unclaimed-dividend policy (rollover vs return) + claim window handling.

### E. Auth & authorization (wallet-based)
- [x] Challenge/nonce endpoint + Stellar signature verification → session/JWT. (`src/auth/`; nonce in Valkey.)
- [x] Role guards (entrepreneur / admin / investor) over the `roles` array. (`JwtAuthGuard`/`RolesGuard`/`ApprovedEntrepreneurGuard`, manual — no passport.)
- [x] Investor onboarding: wallet register → KYC → backend writes the address into `ComplianceRegistry` (the on-chain whitelist). (`src/kyc/kyc-whitelist.*`, BullMQ.)
- [x] Whitelist/KYC management: add on approval, **revoke** on expiry/sanction; gates both invest (mint) and post-unlock transfers. (`POST /admin/kyc/:userId/approve|revoke` → `registry.add`/`remove`.)

### F. API surface (NestJS modules per entity)
- [x] Proposals — submit, list, get (entrepreneur). (`/proposals`, gated by `ApprovedEntrepreneurGuard`.)
- [x] Reviews — approve/reject workflow (admin) → triggers on-chain deploy. (`POST /admin/proposals/:id/approve|reject`.)
- [ ] Campaigns — list live/locked, detail. (Deploy orchestration built; **read/detail endpoints not yet**.)
- [ ] Investments — invest into a campaign (**whitelisted / KYC'd investors only**), list per investor.
- [ ] Distributions & Claims — list entitlements, fetch proof, mark claimed.
- [ ] Validation (DTOs), pagination, error handling. (DTOs + global `ValidationPipe` done; **pagination not yet**.)

### G. Cross-cutting
- [ ] Tests (unit + e2e) for services and the indexer. (Colocated `*.spec.ts` ship with every service/guard; **indexer tests pending its build**.)
- [ ] Observability/logging for the indexer and on-chain calls.
- [x] Revisit Prisma 7 (driver adapter + `prisma.config.ts`). (Migrated to 7.8.)

### H. Refunds & cancellation
> Admin-triggered refund for a problematic funded campaign. See the
> [refund flow](#refund-flow-campaign-cancellation) and Decision #15.
- [x] Contract freeze + refund path (`contracts/campaign`) — `cancel()` freezes `invest()`/`release_milestone()`; `set_refund(root)` posts a distinct refund root; `refund_claim(index, addr, amount, proof)` pays pro-rata principal (no whitelist gate — investor pulling their own money). Reuses `DistributionLeaf` + `merkle::verify_proof` verbatim. _(Built; **pending WASM redeploy** — rides the same re-upload as milestones.)_
- [x] `Refund` / `RefundClaim` models (mirror `ProfitDistribution` / `DistributionClaim`; unique tx-hash idempotency keys) + migration.
- [x] Refund orchestrator (`src/refund/`, the 4th BullMQ orchestrator) — `cancel()` → snapshot holdings → pro-rata over **remaining custody** (`raised − released`, read on-chain) → build Merkle tree + persist claims → `set_refund(root)` → COMPLETED.
- [x] Admin cancel trigger (`POST /admin/campaigns/:id/cancel`, `src/admin/admin-campaign.*`) — flips `Campaign` CANCELLED + opens the `Refund` in one tx, enqueues after commit (mirrors proposal approval); idempotent on the unique `campaignId`.
- [x] Investor claim relay (`GET /refunds/mine`, `POST /refunds/:id/claim/prepare|claim`) — same prepare/sign/submit shape as dividend `claim()`, no deposit step.
- [x] CANCELLED guards on the milestone services (release reconcile/drive skip; voting submit/settle skip) so no work is attempted against a frozen contract.
- [ ] On-chain e2e (needs a funded `STELLAR_PLATFORM_SECRET` + the redeployed WASM).

---

## Open questions / TBD
- Exact settlement model at campaign end (principal return + final profit).
- Unclaimed-dividend policy (rollover to next distribution vs return to business).
- Whether a secondary market (AMM) is ever reintroduced, and if so its liquidity source.
- Regulatory posture (OJK Securities Crowdfunding) for transfer restrictions & KYC.
