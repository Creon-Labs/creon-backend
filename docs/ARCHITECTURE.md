# Creon — Architecture Decisions & Build Roadmap

> Technical companion to [PROJECT.md](./PROJECT.md). It records the **decisions**
> made for the backend data & on-chain value model, and the **checklist of what
> still needs to be built**. Keep it up to date as decisions change or work lands.
>
> Last updated: 2026-06-28.

## Status at a glance

- ✅ **Persistence foundation implemented** — Prisma + PostgreSQL schema
  (10 models + 8 enums), initial migration, global `PrismaModule`, docker-compose
  Postgres, seed. See `prisma/schema.prisma` and `src/prisma/`.
- ⏳ Everything on-chain (Soroban contracts, indexer, dividend distribution),
  auth, and the API surface is **not yet built** — see the [roadmap](#build-roadmap).

---

## Architecture decisions

| # | Decision | Why | Status |
|---|----------|-----|--------|
| 1 | **Prisma + PostgreSQL** as ORM/DB | Type-safe, fast migrations; Postgres fits financial data | ✅ Implemented |
| 2 | **Wallet-based identity** (Stellar public key); email optional | Web3 product — wallet is the natural identity | ⏳ Auth flow not built |
| 3 | **Share = restricted SEP-41 token**, non-transferable during lock, whitelist after unlock | Programmable lock/transfer rules (classic assets only allow coarse auth flags); reuses a token standard instead of a hand-rolled percentage ledger | ⏳ Contract not built |
| 4 | **Returns via dividends / bagi hasil** (NOT buyback) | Transparent & easy to value for retail UMKM investors; value is conserved (can't both pay cash and inflate price from the same profit) | ✅ Schema supports it |
| 5 | **Pull-based distribution** (investors `claim()`, not push) | Pushing payouts in a loop is gas-heavy and a DoS risk; pull scales and is safe | ✅ Schema supports it |
| 6 | **Entitlement via Merkle snapshot** (NOT an accumulator/transfer-hook token) | After unlock holders change, so ownership must be pinned to a moment. Backend snapshots balances off-chain, posts a **merkle root** on-chain; claims verify against it → trust-minimized, and the token stays standard SEP-41 | ⏳ Service not built |
| 7 | **Custody via Vault/Escrow** (NOT an AMM pool) | An AMM is redundant in a dividend model and contradicts crowdfunding — exit liquidity would require parking the very USDC that must go to the business | ✅ `CampaignVault` model |
| 8 | **Lifecycle Model A** — periodic dividends allowed **during** the lock | Lock secures the *principal* + token *transferability*, not profit-sharing; business can share profit while capital stays locked | ✅ Schema supports it |
| 9 | **Ownership tracked in `TokenHolding`** (fed by an event indexer) | SEP-41 is **not enumerable on-chain** (like ERC-20). After unlock, `Investment` ≠ current ownership; the indexer rebuilds holdings from transfer/mint events | ⏳ Indexer not built |
| 10 | **Money precision** `Decimal(28,7)`; `rewardPerShare` `Decimal(38,18)` | Matches Stellar's 7 decimals; extra precision on the per-share accumulator avoids rounding drift | ✅ Implemented |
| 11 | **Prisma pinned to `^6`** (not 7) | Prisma 7 drops `url = env()` and requires a driver adapter + `prisma.config.ts` — deferred to avoid friction | ✅ Implemented |

### Key distinction to remember: what "lock" actually locks
Lock applies to **(a) withdrawing principal** and **(b) transferring the share
token** — **not** to receiving dividends. Dividends (`ProfitDistribution` /
`DistributionClaim`) can flow during the lock and continue after unlock. After
unlock the pool's only role would be exit/secondary market (we deferred the AMM),
so exit is via P2P token transfer to whitelisted addresses.

---

## Data model (implemented)

10 models in `prisma/schema.prisma`:

```
User ──┬─ proposals (entrepreneur)        Proposal ──1:1──> Campaign
       ├─ reviews   (admin)                  │                 ├─1:1──> ProjectToken   (isTransferable = lock flag)
       ├─ investments                        │                 ├─1:1──> CampaignVault  (custody + lock + release)
       ├─ holdings (TokenHolding)            │                 ├─1:N──> Investment     (lpTokens = pro-rata basis)
       └─ distributionClaims                 │                 ├─1:N──> TokenHolding   (current ownership, from indexer)
                                             │                 └─1:N──> ProfitDistribution ─1:N─> DistributionClaim
                                             └─1:N──> ProposalReview (approval audit trail)
```

The DB is an **off-chain mirror** of on-chain state: it stores contract addresses
+ tx hashes, with `tx_hash` unique for idempotent reconciliation.

---

## Dividend distribution flow (Merkle snapshot)

The target flow once the on-chain pieces exist:

```
1. Business earns profit → deposit_profit(USDC) to the Distribution contract
        └─ contract emits ProfitDeposited(campaign, amount, ledger)
2. Indexer captures the event → fix the SNAPSHOT LEDGER (= deposit ledger)
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

## System components beyond the database

```
Soroban RPC (getEvents) ──transfer/mint/burn/claim events──► Event Indexer (worker)
                                                                  │
                                                                  ├─► raw event log (audit / rebuild)
                                                                  └─► TokenHolding (current balances) ──► dividend snapshot
```

The **event indexer is load-bearing infra**, not optional: SEP-41 has no on-chain
holder enumeration, and Soroban RPC event retention is short (a few days), so the
backend must ingest continuously from token-deploy ledger onward and persist the
raw log.

---

## Build roadmap

What still needs to be built, grouped by area. Check items off as they land.

### A. Soroban smart contracts
- [ ] Campaign contract (created on proposal approval; holds campaign lifecycle).
- [ ] **Restricted SEP-41 share token** — transfer gated by lock period + whitelist (KYC).
- [ ] Vault/Escrow contract — custody of fundraised USDC, lock, release to business.
- [ ] Distribution contract — `deposit_profit`, `set_distribution(merkleRoot)`, `claim(amount, proof)` with on-chain proof verification.
- [ ] Test USDC asset setup on Stellar testnet.

### B. On-chain integration (backend ↔ Stellar)
- [ ] Stellar SDK / Soroban RPC client wiring + signing for platform-side txs.
- [ ] Deploy orchestration: on approval → deploy campaign + token + vault, persist contract addresses + `deploy_tx_hash`.
- [ ] Idempotent reconciliation keyed on `tx_hash` (schema already enforces uniqueness).

### C. Event indexer worker
- [ ] Subscribe to Soroban RPC `getEvents` for share-token transfer/mint/burn + distribution events.
- [ ] Persist a raw event log; maintain `TokenHolding` (upsert balances by `(campaignId, holderAddress)`).
- [ ] Continuous ingestion from deploy ledger (handle short RPC retention); reconciliation/backfill strategy.
- [ ] Update `Investment` / `ProfitDistribution` / `DistributionClaim` statuses from on-chain events.

### D. Dividend / Merkle distribution service
- [ ] On `ProfitDeposited`: snapshot `TokenHolding` at the deposit ledger.
- [ ] Compute pro-rata entitlements; build Merkle tree + root; persist `ProfitDistribution` + per-holder `DistributionClaim` (with `merkleProof`).
- [ ] Post the root on-chain; expose proofs to the frontend for claiming.
- [ ] Unclaimed-dividend policy (rollover vs return) + claim window handling.

### E. Auth & authorization (wallet-based)
- [ ] Challenge/nonce endpoint + Stellar signature verification → session/JWT.
- [ ] Role guards (entrepreneur / admin / investor) over the `roles` array.
- [ ] Whitelist/KYC management for post-unlock transfers.

### F. API surface (NestJS modules per entity)
- [ ] Proposals — submit, list, get (entrepreneur).
- [ ] Reviews — approve/reject workflow (admin) → triggers on-chain deploy.
- [ ] Campaigns — list live/locked, detail.
- [ ] Investments — invest into a campaign, list per investor.
- [ ] Distributions & Claims — list entitlements, fetch proof, mark claimed.
- [ ] Validation (DTOs), pagination, error handling.

### G. Cross-cutting
- [ ] Tests (unit + e2e) for services and the indexer.
- [ ] Observability/logging for the indexer and on-chain calls.
- [ ] Revisit Prisma 7 (driver adapter + `prisma.config.ts`) when convenient.

---

## Open questions / TBD
- Exact settlement model at campaign end (principal return + final profit).
- Unclaimed-dividend policy (rollover to next distribution vs return to business).
- Whether a secondary market (AMM) is ever reintroduced, and if so its liquidity source.
- Regulatory posture (OJK Securities Crowdfunding) for transfer restrictions & KYC.
