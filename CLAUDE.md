# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

`creon-backend` is the NestJS backend for **Creon**, a web3 crowdfunding ("urun dana")
platform for Indonesian UMKM (micro/small/medium enterprises) on **Stellar/Soroban**.
Entrepreneurs submit funding proposals; admins approve them; approved proposals
become on-chain campaigns that investors fund with USDC. Returns flow back as
**dividends (bagi hasil)**, not buyback. See `docs/PROJECT.md` (narrative) and
`docs/ARCHITECTURE.md` (decisions + roadmap) for the full domain model.

Status: persistence + wallet-auth + KYC/admin-approval are built. On-chain
integration (Soroban contracts, the event indexer, dividend distribution) is **not
yet built** — `docs/ARCHITECTURE.md` is the roadmap.

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
- **Stellar signature verification uses `@stellar/stellar-base`, NOT the full
  `@stellar/stellar-sdk`.** The full SDK pulls ESM-only deps that break ts-jest.
  Jest's `transformIgnorePatterns` allowlists `@noble|@scure|@stellar|@stablelib`
  so they get transformed — preserve it when adding Stellar code.
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
`PrismaModule` (global), `StorageModule`, `CacheModule` (global), `AuthModule`,
`KycModule`, `AdminModule`. `main.ts` installs a global `ValidationPipe`
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
  `ApprovedEntrepreneurGuard` (role ENTREPRENEUR **and** `EntrepreneurProfile.status
  === APPROVED`; built + tested but **not yet wired** — no proposal route exists).
- Decorators: `@Roles(...)`, `@CurrentUser()`. `AuthModule` re-exports `JwtModule`
  so importing modules get `JwtService` for the guards.

**KYC + admin approval** (`src/kyc/`, `src/admin/`):
- `POST /kyc` (entrepreneur) takes identity fields + `idCard` and `selfie` images
  (both required, jpeg/png, ≤5 MB, memory storage via `FileFieldsInterceptor`).
  Images are stored as object **keys** in the private KYC bucket
  (`kyc/<userId>/<kind>-<uuid>.<ext>`); upserts one `EntrepreneurProfile` per user
  → status PENDING. `nationalId` (NIK) is `@unique` (anti-Sybil) → P2002 returns 409.
- `GET /kyc/me` returns the caller's status.
- `admin/kyc` (admin): `GET ?status=` (returns presigned image URLs),
  `POST :userId/approve`, `POST :userId/reject {reason}`.

**Data model** (`prisma/schema.prisma`): 11 models + 9 enums. DB columns are
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
