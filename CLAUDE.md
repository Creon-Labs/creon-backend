# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

`creon-backend` is the NestJS backend for **Creon**, a web3 crowdfunding ("urun dana")
platform for Indonesian UMKM (micro/small/medium enterprises) on **Stellar/Soroban**.
Entrepreneurs submit funding proposals; admins approve them; approved proposals
become on-chain campaigns that investors fund with USDC. Returns flow back as
**dividends (bagi hasil)**, not buyback. See `docs/PROJECT.md` (narrative) and
`docs/ARCHITECTURE.md` (decisions + roadmap) for the full domain model.

Status: persistence, wallet-auth, KYC/admin-approval, entrepreneur proposals,
**on-chain integration through campaign deploy**, investment recording, the
**ownership indexer** (rebuilds `TokenHolding`), and the **dividend distribution +
claim flow** (Merkle snapshots) are built. The Soroban contracts
(`contracts/`) are deployed to **testnet**; the backend deploys a per-campaign
`ShareToken` + `Campaign` on proposal approval and syncs KYC approvals into the
on-chain whitelist — both as idempotent BullMQ orchestrators. Dividends: the business
deposits profit (relay), a BullMQ orchestrator snapshots holdings → builds a Merkle
tree → posts `set_distribution`, and investors `claim()` (relay). **Milestone-based
staged release** (hybrid on-chain `release_milestone` + off-chain weighted voting) and
an **admin-triggered refund/cancellation** flow (dedicated on-chain
`cancel`/`set_refund`/`refund_claim`) are also built — both on `dev`, both awaiting the
pending `Campaign` WASM re-upload before on-chain e2e. See `docs/ARCHITECTURE.md`
(roadmap) and `docs/SMART_CONTRACT_PLAN.md` (phased plan) — Phases 1–6 are done.
Remaining work is on-chain e2e (needs a funded `STELLAR_PLATFORM_SECRET`) and
post-hackathon hardening.

## Commands

Package manager is **pnpm**. Use it, not npm/yarn.

```bash
pnpm install
docker compose up -d                 # Postgres 16, Valkey 8, MinIO (+ bucket init)
pnpm prisma:generate                 # REQUIRED after install/clone — see note below
pnpm prisma:migrate                  # apply migrations (prisma migrate dev)
pnpm db:seed                         # seed via tsx prisma/seed.ts

pnpm start:dev                       # watch mode
pnpm build && pnpm start:prod        # production

pnpm test                            # all unit tests (*.spec.ts, jest)
pnpm test path/to/file.spec.ts       # a single test file
pnpm test -t "name of test"          # tests matching a name
pnpm test:cov                        # coverage
pnpm test:e2e                        # e2e (test/jest-e2e.json)

pnpm lint                            # eslint --fix
pnpm format                          # prettier --write
pnpm prisma:studio                   # browse the DB
```

The Soroban contracts in `contracts/` are a **standalone Cargo workspace**, kept out
of the pnpm/Nest build (no npm scripts touch them). Work on them from `contracts/`:

```bash
cargo test              # unit + integration tests (host target)
stellar contract build  # -> target/wasm32v1-none/release/*.wasm
```

## Critical gotchas (read before building or running)

- **`generated/` is gitignored.** The Prisma client is generated to
  `generated/prisma` (not `node_modules`), so a fresh clone has no client until you
  run `pnpm prisma:generate`. Build/tests fail without it. Import it via relative
  path, e.g. `import { Role } from '../../generated/prisma/enums'`.
- **Prisma 7 + driver adapter.** `PrismaService` constructs its own
  `new PrismaPg({ connectionString: process.env.DATABASE_URL })`. The schema
  `datasource` has **no `url`** — the connection string lives in `prisma.config.ts`
  via `env('DATABASE_URL')`. Generator is `prisma-client` (not `prisma-client-js`).
  (Note: `docs/ARCHITECTURE.md` still says "Prisma pinned to ^6" — that is stale;
  the repo is on 7.8.)
- **The generated client uses `.js` extension imports.** Jest resolves them via
  `moduleNameMapper: {"^(\\.{1,2}/.*)\\.js$": "$1"}` (in `package.json#jest`).
  Keep that mapping if you touch the jest config.
- **Two Stellar packages, used deliberately.** Wallet-auth **signature
  verification** uses the lean `@stellar/stellar-base` (`src/auth/`). The **Soroban
  RPC + transaction-building** surface (`src/soroban/`) needs the full
  `@stellar/stellar-sdk` (`rpc.Server`, `Operation`, `xdr`, …). Both pull ESM-only
  deps that break ts-jest, so Jest's `transformIgnorePatterns` allowlists
  `@noble|@scure|@stellar|@stablelib|uint8array-extras` for transform — preserve
  that list when adding Stellar/Soroban code.
- **Seed runs through `tsx`** (`prisma.config.ts` → `tsx prisma/seed.ts`) to avoid
  nodenext/ts-node ESM friction.
- **pnpm blocks build scripts by default.** Prisma engines / esbuild are allowlisted
  in `package.json#pnpm.onlyBuiltDependencies`.
- **Controllers must `import type { AuthUser }`** (a `type`-only import). With
  `isolatedModules` + `emitDecoratorMetadata`, a value import on a decorated param
  type fails. There is no `@types/multer` (multer 2 ships none) — a minimal
  `UploadedFile` interface lives in `src/kyc/uploaded-file.ts`.

## Architecture

NestJS module-per-domain. `app.module.ts` wires: `ConfigModule` (global),
`ScheduleModule` (for the reconcile loops), `BullModule.forRootAsync` (the shared
Valkey/BullMQ connection + `defaultJobOptions`: 5 attempts, exponential 5 s backoff,
`removeOnComplete`), then `PrismaModule` (global), `StorageModule`, `CacheModule`
(global), `SorobanModule`, `AuthModule`, `KycModule`, `AdminModule`,
`ProposalModule`, `CampaignModule`, `InvestmentModule`, `IndexerModule`,
`HoldingModule`, `DistributionModule`, `MilestoneModule`, `RefundModule`. `main.ts`
installs a global `ValidationPipe`
(`whitelist + transform`) and a `BigInt.prototype.toJSON` patch so Prisma
ledger-sequence fields serialize to JSON.

**Infrastructure wrappers** (thin, env-configured via `ConfigService`):
- `src/prisma/` — `PrismaService` extends the generated `PrismaClient`; global.
- `src/cache/` — `CacheService` wraps **Valkey** (`@valkey/valkey-glide`); global.
  Connection is built in `onModuleInit` (the glide factory is async). Used for
  general caching and short-lived wallet-auth challenges.
- `src/storage/` — `StorageService` wraps an S3-compatible store (**MinIO** in dev,
  **Cloudflare R2** in prod). Most methods take an optional trailing `bucket?` arg
  that falls back to the default `R2_BUCKET`; the private KYC bucket
  (`R2_KYC_BUCKET`) is passed explicitly. Private objects are served only via
  `getPresignedDownloadUrl`, never a public URL.

**Auth** (`src/auth/`) — wallet-based, JWT-stateless:
- Flow: `POST /auth/challenge` issues a single-use nonce (stored in Valkey under
  `auth:challenge:<wallet>`, TTL `AUTH_CHALLENGE_TTL_SECONDS`); client signs it;
  `POST /auth/register` or `/auth/login` verifies the Stellar signature and mints a
  JWT with payload `{ sub: userId, roles }`. Verifying deletes the challenge (no replay).
- Guards (manual, **no passport**): `JwtAuthGuard` (verifies bearer token, attaches
  `request.user`), `RolesGuard` (reads `@Roles(...)` via `Reflector`),
  `ApprovedEntrepreneurGuard` (role ENTREPRENEUR **and** `KycProfile.status
  === APPROVED`; now wired on the `/proposals` write routes — create/update/submit).
- Decorators: `@Roles(...)`, `@CurrentUser()`. `AuthModule` re-exports `JwtModule`
  so importing modules get `JwtService` for the guards.

**KYC + admin approval** (`src/kyc/`, `src/admin/`):
- KYC is **per user, role-agnostic** (one `KycProfile` per user) — both
  ENTREPRENEUR and INVESTOR submit through the same route. Investors register via
  `POST /auth/register` with `role: INVESTOR` (no dedicated endpoint).
- `POST /kyc` (entrepreneur **or** investor) takes identity fields + `idCard` and
  `selfie` images (both required, jpeg/png, ≤5 MB, memory storage via
  `FileFieldsInterceptor`). Images are stored as object **keys** in the private KYC
  bucket (`kyc/<userId>/<kind>-<uuid>.<ext>`); upserts one `KycProfile` per user
  → status PENDING. `nationalId` (NIK) is `@unique` (anti-Sybil) → P2002 returns 409.
- `GET /kyc/me` returns the caller's status.
- `admin/kyc` (admin): `GET ?status=` (returns presigned image URLs + each
  submitter's `roles`), `POST :userId/approve`, `POST :userId/reject {reason}`,
  `POST :userId/revoke {reason}` (APPROVED → REVOKED). Approve and revoke each
  **enqueue an on-chain whitelist sync** (see orchestration below).

**Proposals + admin review** (`src/proposal/`, `src/admin/admin-proposal.*`):
- `/proposals` (ENTREPRENEUR, approved KYC): `POST` create as DRAFT, `GET` list own,
  `GET :id` one own, `PATCH :id` edit while DRAFT, `POST :id/submit` (DRAFT →
  SUBMITTED). Reads are owner-scoped, so another user's proposal 404s. Off-chain
  only — no Campaign row, no deploy yet.
- `admin/proposals` (admin): `GET ?status=`, `POST :id/approve`, `POST :id/reject
  {reason}`. **Approval is the deploy trigger**: in one transaction it writes a
  `ProposalReview`, flips the proposal APPROVED, and materializes the Campaign mirror
  (`CampaignService.createForProposal` → `Campaign` + `ProjectToken` + `CampaignVault`
  rows, `PENDING_DEPLOYMENT` / deploy `PENDING`); after commit it enqueues the async
  deploy. Never deploys inside the HTTP request.

**On-chain integration** (`src/soroban/`, `src/campaign/`, `src/kyc/kyc-whitelist.*`):
- `SorobanService` — thin wrapper over `@stellar/stellar-sdk`'s Soroban RPC +
  tx-building surface, same env-configured `@Injectable` pattern as the other infra
  wrappers. Every platform tx (deploys, `set_minter`, `registry.add/remove`,
  `release_milestone`, `cancel`/`set_refund`) is
  signed by the single `STELLAR_PLATFORM_SECRET` key, which is the `owner` of every
  contract; the keypair is built **lazily** so the app boots without it for non-chain
  work. Deploys are **idempotent**: a deterministic per-`(campaign, kind)` salt plus
  an on-chain pre-check (`contractExists`) means a retry recovers the same address
  instead of duplicating.
- **Five BullMQ orchestrators, one shared shape.** `campaign-deploy`,
  `kyc-whitelist`, `distribution`, `milestone-release`, and `refund` each have: a `*Service` that is an idempotent,
  resumable state machine (`drive()`), a thin `*Processor` (`WorkerHost`) that just calls `drive()`
  (a throw fails the job → BullMQ retries with backoff), and a **reconcile loop**
  (`@Interval` every 5 min **and** `onApplicationBootstrap`) that re-enqueues any
  unfinished entity — recovering work whose queue job was lost (e.g. Valkey
  restarted) without an app restart. `enqueue` uses `jobId = <entityId>` and clears
  any stale job first, so adds dedupe but a re-enqueue always re-attempts. Crucially,
  each step's resume point is derived from **what is already persisted** (e.g. token
  address → campaign address → wire tx), not from the status column alone.
- Campaign deploy state machine (`CampaignDeployStatus`): `PENDING →
  DEPLOYING_TOKEN → DEPLOYING_CAMPAIGN → WIRING → LIVE` (`FAILED` on error). Steps:
  deploy the `ShareToken`, deploy the `Campaign` contract, `token.set_minter(campaign)`,
  then flip the campaign `LIVE`/`ACTIVE` and the vault `FUNDING`.
- KYC whitelist sync (`WhitelistStatus`): desired on-chain state is **derived from
  the KYC review status** — APPROVED → `registry.add(wallet)` → WHITELISTED, REVOKED
  → `registry.remove(wallet)` → REMOVED. On-chain add/remove are themselves
  idempotent, so a duplicate job can't corrupt state.
- Distribution orchestrator (`src/distribution/`, `DistributionStatus`): the third
  orchestrator. The business deposits profit via a prepare/submit **relay** (mirrors
  invest — `deposit_profit()` needs the depositor's auth), which opens a
  `ProfitDistribution` (PENDING) and enqueues `drive()`: snapshot registered
  `TokenHolding` → integer-floor pro-rata entitlements → build a **commutative
  SHA-256 Merkle tree** (`src/distribution/merkle.util.ts`) → persist one
  `DistributionClaim` per holder → `set_distribution(onchainId, root)` on-chain →
  COMPLETED. Investors then `claim()` via the same relay shape; the submit endpoint
  marks the claim CLAIMED (idempotent on `claim_tx_hash`). **Leaf/tree encoding must
  match the contract byte-for-byte** — it is pinned to a Rust-emitted vector
  (`print_merkle_test_vector` in `contracts/campaign/src/test.rs`); the leaf `ScVal`
  map is keyed `address` < `amount` < `index`. Unclaimed dividends stay claimable
  indefinitely (the contract has no reclaim path).
- Milestone release orchestrator (`src/milestone/`, `MilestoneStatus`): once a
  milestone vote settles APPROVED (see the off-chain voting service), the on-chain
  `release_milestone(index)` is enqueued and driven `APPROVED → RELEASING → RELEASED`
  (resume derived from `releaseTxHash`), bumping the vault's `releasedToBusiness`. The
  contract enforces sequential once-only release, so a duplicate reverts
  `MilestoneOutOfOrder` — treated as "already released". A CANCELLED campaign is
  skipped (its contract is frozen — see refunds below).
- Refund orchestrator (`src/refund/`, `RefundStatus`): the refund/cancellation path
  for a problematic **funded** campaign. Admin `POST /admin/campaigns/:id/cancel
  {reason}` flips the campaign CANCELLED **and** opens a `Refund` row in one tx
  (mirrors proposal approval), then enqueues `drive()`: `cancel()` on-chain (which
  **freezes `invest()` + `release_milestone()`**) → snapshot `TokenHolding` →
  integer-floor pro-rata over the **remaining custody** (`raised − released`, read
  on-chain, so Σ ≤ actual custody even if the mirror drifted) → build a refund Merkle
  tree (**reuses `src/distribution/merkle.util.ts` and the contract's `DistributionLeaf`
  encoding verbatim**) → persist one `RefundClaim` per holder → `set_refund(root)`
  on-chain → COMPLETED. Investors `refund_claim()` via the same relay shape (no deposit
  step — the money is the principal already in custody; idempotent on `claim_tx_hash`).
  Shares are **not** burned (a CANCELLED campaign runs no further dividends/milestones).
  The milestone services carry CANCELLED guards so no work is driven against a frozen
  contract.

**Ownership indexer** (`src/indexer/`, `TokenHoldingIndexerService`) — the one
non-BullMQ loop: a plain `@Interval` (+ `onApplicationBootstrap`) poll, since there's
no per-entity retry, just a continuous cursor. Each tick asks `SorobanService.getContractEvents`
(read-only `getEvents`, chunked to the RPC's 5-contract cap) which addresses each
`LIVE` `ShareToken` touched since the last processed ledger, then writes a **fresh
on-chain `readBalance()`** (read-only simulation) into `TokenHolding` — the balance is
never decoded from the event body, so a mis-parsed event can't corrupt the ledger. The
ledger cursor lives in Valkey via `CacheService` (no migration); it **only advances on a
fully successful poll**, so a failed tick just re-reads the same window. Cold start seeds
a bounded lookback (`INDEXER_LOOKBACK_LEDGERS`) from the latest ledger.

**Soroban contracts** (`contracts/`, standalone Cargo workspace) — deployed to
testnet; addresses + WASM hashes live in `contracts/deployments/testnet.json` and
are wired into the backend via `COMPLIANCE_REGISTRY_ADDRESS`, `SHARE_TOKEN_WASM_HASH`,
`CAMPAIGN_WASM_HASH`, `USDC_CONTRACT_ADDRESS`, `STELLAR_*` (see `.env.example`).
Three crates: `compliance-registry` (owner-gated KYC whitelist singleton),
`share-token` (per-campaign restricted SEP-41), `campaign` (merged vault + lifecycle
+ Merkle-proof dividend distribution + milestone release + refund-on-cancel). See
`contracts/README.md`.

**Data model** (`prisma/schema.prisma`): 15 models + 15 enums. DB columns are
snake_case via `@map`; timestamps are `@db.Timestamptz`. The DB is an **off-chain
mirror** of on-chain state — it stores contract addresses + tx hashes, with
`tx_hash` unique for idempotent reconciliation. Money is `Decimal(28,7)` (Stellar's
7 decimals); `rewardPerShare` is `Decimal(38,18)`.

Key domain invariants to remember (from `docs/ARCHITECTURE.md`):
- Shares are a **restricted SEP-41 token** (non-transferable during lock).
- Dividends are **pull-based** (`claim()`), entitlement pinned by a **Merkle
  snapshot** whose root is posted on-chain — the backend can't forge amounts.
- SEP-41 is **not enumerable on-chain**, so current ownership lives in
  `TokenHolding`, rebuilt by a (not-yet-built) event indexer; `Investment` rows are
  historical purchase records, not live ownership after unlock.
- "Lock" locks principal withdrawal + token transfer, **not** dividend receipt.

## Conventions

- DTOs use `class-validator` / `class-transformer`; the global `ValidationPipe`
  strips unknown properties (`whitelist`) and coerces types (`transform`).
- Services throw Nest HTTP exceptions (`BadRequestException`, `ConflictException`,
  `NotFoundException`, `UnauthorizedException`) rather than returning error shapes.
- Every service/guard ships a colocated `*.spec.ts`; mirror that when adding code.
- Config is read through `ConfigService` (`getOrThrow` for required vars); see
  `.env.example` for the full key list.
