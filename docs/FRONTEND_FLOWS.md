# Frontend Integration Flows

What a frontend needs to implement to work with `creon-backend`, written around
*what the user does* and *what the wallet signs* — not the internal service
architecture (see `ARCHITECTURE.md`). Full request/response shapes live in
`openapi.yaml`; this doc is the "why and in what order."

## Core concepts (read first)

**Wallet-auth, not passwords.** Identity = a Stellar keypair. You need a wallet
integration (Freighter, xBull, or any signer) that can:
1. Return the public key (`G...`, 56 chars).
2. Sign a raw UTF-8 message → base64 signature (for auth).
3. Sign a base64 XDR tx envelope → signed base64 XDR (for on-chain actions).

**JWT.** Every authenticated call needs `Authorization: Bearer <token>`. Minted
at register/login, embeds `{ sub: userId, roles: Role[] }`, expires in **7 days**
(`JWT_EXPIRES_IN`). No refresh endpoint — on expiry, re-run login.

**The relay pattern (prepare → sign → submit).** Anything touching the user's own
USDC/shares (`invest`, `deposit_profit`, `claim`) needs *their* signature — the
contract checks `require_auth()`. The platform can't sign for them, so these are
always three steps:
1. `POST .../prepare` → backend returns `{ xdr }` (unsigned, source = user's wallet).
2. Wallet signs that **exact** XDR (do not modify it) → signed XDR.
3. `POST .../submit` with `{ signedXdr }` → backend verifies the decoded call
   matches what it expected (contract, function, args, caller), **fee-bumps with
   the platform account**, submits, and records the result.

Consequences: the **user never pays network fees** and needs no XLM — only USDC
(plus a wallet that signs Soroban invoke txs). Submit endpoints are **idempotent**:
re-submitting the same signed XDR returns the recorded row instead of double-submitting.

**Roles.** A user holds `ENTREPRENEUR`, `INVESTOR`, or both. `ADMIN` is seed-only,
never surfaced at registration. **KYC is per-user, not per-role** — one submission
covers both roles.

**Two independent approval gates.** KYC approval (identity) and campaign approval
(proposal review) are separate admin actions with separate statuses — don't
conflate them in the UI.

---

## Flow 1 — Register / Login (wallet-signature auth)

Same challenge-response for both; only the final endpoint differs.

**Steps**
1. Request a challenge for the wallet address.
2. Wallet signs the returned `message` **as raw bytes** (a message signature, *not*
   a transaction) → `signatureB64`.
3. Call **register** (new user) or **login** (existing) with the signature → `accessToken`.
4. Store the token; attach `Authorization: Bearer <token>` on every later call.

**Endpoints**

| Step | Method + Path | Body → returns |
|---|---|---|
| 1 | `POST /auth/challenge` | `{ walletAddress }` → `{ message }` (fixed-format multi-line string) |
| 3a | `POST /auth/register` | `{ walletAddress, signature, role, email?, displayName? }` → `{ accessToken }` |
| 3b | `POST /auth/login` | `{ walletAddress, signature }` → `{ accessToken }` |

**Caveats**
- **Challenge is single-use, expires in 5 min** (`AUTH_CHALLENGE_TTL_SECONDS`) —
  sign promptly; re-request a fresh challenge if register/login fails with 401.
- **`role` is `ENTREPRENEUR` or `INVESTOR` only** (pick from the onboarding flow
  the user started). `email` is **required when role is ENTREPRENEUR**, optional
  otherwise.
- **One registration per wallet** — there's no "add role" endpoint; treat each
  wallet as single-role in the UI.
- **`login` is not role-restricted** — any registered wallet (incl. a seeded
  admin) can log in.

---

## Flow 2 — KYC submission & approval

Off-chain submission, identical for entrepreneurs and investors (gated by role via
`@Roles`).

**Steps**
1. Submit identity fields + ID card and selfie images (multipart).
2. Poll status until an admin decides (no push/webhook).

**Endpoints**

| Step | Method + Path | Body → returns |
|---|---|---|
| 1 | `POST /kyc` (multipart) | fields: `fullName`, `nationalId` (16-digit NIK), `dateOfBirth?` (YYYY-MM-DD); files: `idCard`, `selfie` (jpeg/png, ≤5MB) → `{ status: "PENDING", submittedAt }` |
| 2 | `GET /kyc/me` | → `{ status: "PENDING" \| "APPROVED" \| "REJECTED" \| "REVOKED", ... }` |

**Caveats**
- **`nationalId` is globally unique → 409 Conflict** if reused by another account.
  Surface as "this ID has already been used to verify a different account."
- **Resubmitting while PENDING/REJECTED** overwrites the profile (upsert) and
  resets to PENDING.
- **Poll `GET /kyc/me`** (~every 10–30s while PENDING) or prompt the user to check back.
- **Downstream gates return 403 until APPROVED** (`ApprovedEntrepreneurGuard` /
  `ApprovedInvestorGuard` on proposal-writes and invest/claim). Show a "verify
  your identity first" state instead of a raw 403.
- **`REVOKED`** (admin revokes a previously-approved KYC) blocks all gates like
  REJECTED — treat the same, but copy should differ ("verification was revoked" vs
  "submission was rejected").

**Admin side** (only if building an admin UI): `GET /admin/kyc?status=PENDING`,
`POST /admin/kyc/:userId/approve`, `.../reject { reason }`, `.../revoke { reason }`.
Approve/revoke kick off an async on-chain whitelist sync — the KYC `status` flips
immediately, but the investor's *ability to actually invest* also depends on the
whitelist landing on-chain (see Flow 4 caveat).

---

## Flow 3 — Entrepreneur: submit a funding proposal

Off-chain only — no contract touched. All write routes require
`ApprovedEntrepreneurGuard` (role + KYC APPROVED), so build KYC first and gate the
"New Proposal" button on `GET /kyc/me`.

**Steps**
1. Create a proposal (starts as `DRAFT`).
2. Edit while `DRAFT` (optional).
3. Submit → `DRAFT → SUBMITTED` (locks editing).
4. Poll for the admin decision.

**Endpoints**

| Step | Method + Path | Notes |
|---|---|---|
| 1 | `POST /proposals` | `{ businessName, businessDescription, category, location?, requestedAmount, lockPeriodDays }` → proposal (`DRAFT`) |
| 2 | `PATCH /proposals/:id` | any subset of the above; **only while `DRAFT`** |
| 3 | `POST /proposals/:id/submit` | `DRAFT → SUBMITTED` |
| 4 | `GET /proposals` / `GET /proposals/:id` | caller's own only (404 if not theirs) |

**Caveats**
- **`requestedAmount` is a string** (`"1500.5000000"`, up to 7 decimals) — never
  send a JS `number` for money fields anywhere in this API.
- **`lockPeriodDays` is an integer 1–3650** → becomes the on-chain principal-lock
  duration after deploy; make its meaning clear ("principal locked this many days
  after go-live").
- **SUBMITTED is read-only** for the entrepreneur — poll `GET /proposals/:id` and
  watch `status` move to `UNDER_REVIEW` → `APPROVED` / `REJECTED`.

---

## Flow 4 — Campaign auto-deploy (system-driven, no user action)

When an admin approves a proposal (`POST /admin/proposals/:id/approve`), the
backend synchronously creates a `Campaign` row and **asynchronously** deploys the
contracts (`ShareToken` + `Campaign`, wires `set_minter`, flips live). Takes
seconds to a couple of minutes; nothing for the frontend to trigger.

**Steps**
1. After a proposal is APPROVED, poll `GET /campaigns/:id` (public, no auth).
2. Watch `deployStatus`: `PENDING → DEPLOYING_TOKEN → DEPLOYING_CAMPAIGN → WIRING → LIVE`
   (or `FAILED`).
3. Enable "Invest" only when `deployStatus === "LIVE"` **and** `status === "ACTIVE"`.

**Endpoints**

| Method + Path | Notes |
|---|---|
| `GET /campaigns` | public; returns **LIVE** campaigns only |
| `GET /campaigns/:id` | public; poll `deployStatus` / `status` here |

**Caveats**
- **Gate "Invest" on both `deployStatus === "LIVE"` and `status === "ACTIVE"`** —
  not just the presence of a `contractAddress`. The invest-prepare endpoint 409s otherwise.
- **Investor whitelist ordering (important):** an investor's wallet must be added
  to the on-chain compliance registry before `invest()` succeeds. This happens
  automatically after KYC approval via a separate async orchestrator, tracked as
  `KycProfile.whitelistStatus` (`NOT_SYNCED → ADDING → WHITELISTED`) — **not
  currently exposed on `GET /kyc/me`**. So if an investor's first `invest` fails
  right after KYC approval, the whitelist sync likely hasn't landed yet — show a
  retry/backoff message, not a hard error (the contract rejects non-whitelisted
  `invest()`).

---

## Flow 5 — Investor: invest in a campaign

Relay pattern (see Core concepts). Requires `INVESTOR` + approved KYC
(`ApprovedInvestorGuard`) and a LIVE/ACTIVE campaign.

**Steps**
1. `prepare` with an amount → `{ campaignId, xdr }`.
2. Wallet signs the XDR.
3. `submit` the signed XDR → confirmed `Investment` (synchronous, no polling).
4. Read holdings/history as needed.

**Endpoints**

| Step | Method + Path | Body → returns |
|---|---|---|
| 1 | `POST /campaigns/:campaignId/investments/prepare` | `{ amount }` → `{ campaignId, xdr }` |
| 3 | `POST /campaigns/:campaignId/investments` | `{ signedXdr }` → `Investment { id, campaignId, amount, lpTokens, txHash, status, investedAt }` |
| 4 | `GET /investments/mine` | caller's purchase history |
| 4 | `GET /holdings/mine` | **live** on-chain-derived balances |

**Caveats**
- **`amount` is USDC, string, up to 7 decimals, > 0.**
- **Shares (`lpTokens`) mint 1:1 with USDC** at confirm time.
- **Wallet needs a USDC trustline + balance before `prepare`** — the backend
  doesn't pre-check; the contract rejects the tx on submit. Surface that plainly.
- **Shares are non-transferable during the lock** (restricted SEP-41) — don't
  build any sell/transfer UI.
- **`status` is `CONFIRMED` once submit succeeds** (submit is synchronous — no
  polling here, unlike deploy).
- **For portfolio/ownership, prefer `GET /holdings/mine`** over summing
  `/investments/mine` — the latter is a historical purchase ledger, not current
  ownership.

---

## Flow 6 — Entrepreneur: distribute dividends (deposit profit)

Relay pattern. Requires `ENTREPRENEUR` + approved KYC, and the caller must own the
campaign (guard checks `proposal.entrepreneurId`).

**Steps**
1. `prepare` with a profit amount → `{ campaignId, xdr }`.
2. Wallet signs the XDR.
3. `submit` → returns **immediately** with `status: "PENDING"`.
4. Poll the distribution until `status === "COMPLETED"` (background job builds the
   Merkle snapshot + posts `set_distribution` on-chain) **before** telling investors
   dividends are claimable.

**Endpoints**

| Step | Method + Path | Body → returns |
|---|---|---|
| 1 | `POST /campaigns/:campaignId/distributions/deposit/prepare` | `{ amount }` → `{ campaignId, xdr }` |
| 3 | `POST /campaigns/:campaignId/distributions/deposit` | `{ signedXdr }` → `ProfitDistribution { id, onchainId, totalAmount, status: "PENDING", ... }` |
| 4 | `GET /campaigns/:campaignId/distributions` | all distributions for a campaign (public) |

**Caveats**
- **`amount` is USDC profit, string, > 0**; wallet needs the USDC (same
  trustline/balance caveat as invest).
- **Submit returns PENDING; the on-chain work is async.** Poll until `COMPLETED` —
  a PENDING distribution has no claims to fetch yet.
- **`totalShares` / `rewardPerShare` / `merkleRoot` populate once the job finishes**
  — treat as absent/loading while PENDING.
- **Entitlements snapshot current holders at deposit-confirm time** (integer-floor
  pro-rata) — no "eligible as of" date to manage; it's automatic.

---

## Flow 7 — Investor: claim a dividend

Relay pattern. Requires `INVESTOR` + approved KYC.

**Steps**
1. List entitlements to find claimable rows.
2. `prepare` a claim for a distribution → `{ distributionId, xdr }`.
3. Wallet signs the XDR.
4. `submit` → `status: "CLAIMED"`; USDC lands directly in the wallet on-chain.

**Endpoints**

| Step | Method + Path | Body → returns |
|---|---|---|
| 1 | `GET /distributions/mine` | `DistributionClaim[] { id, distributionId, amount, status, distribution: { onchainId, campaignId, status } }` |
| 2 | `POST /distributions/:distributionId/claim/prepare` | (no body) → `{ distributionId, xdr }` |
| 4 | `POST /distributions/:distributionId/claim` | `{ signedXdr }` → `DistributionClaim { ..., status: "CLAIMED", claimTxHash, claimedAt }` |

**Caveats**
- **Show "Claim" only when the claim's `status === "PENDING"` AND its nested
  `distribution.status === "COMPLETED"`** — `prepare` 409s if the Merkle root isn't
  posted yet (distribution still PENDING) or there's no entitlement row (held zero
  shares at snapshot; it simply won't appear in `/distributions/mine`).
- **Claiming is not time-limited** — unclaimed dividends stay claimable indefinitely
  (no expiry/reclaim); no "expires in X days" messaging needed.
- **`amount` is the fixed entitlement**, pinned by the Merkle tree server-side — the
  investor can't choose a partial amount.
- **No separate "withdraw" step** — USDC lands in the wallet on a successful claim.

---

## Status field cheat-sheet

What to poll and what each value means, for loading/empty states.

| Entity | Field | Frontend-relevant values |
|---|---|---|
| KYC | `KycProfile.status` | `PENDING` (wait) → `APPROVED` (unlocked) / `REJECTED` / `REVOKED` (blocked, resubmit) |
| Proposal | `Proposal.status` | `DRAFT` (editable) → `SUBMITTED` → `UNDER_REVIEW` → `APPROVED` / `REJECTED` |
| Campaign | `Campaign.deployStatus` | `PENDING`…`WIRING` ("deploying") → `LIVE` (usable) / `FAILED` |
| Campaign | `Campaign.status` | `PENDING_DEPLOYMENT` → `ACTIVE` (investable) → `LOCKED` / `GOAL_REACHED` / `COMPLETED` / `CANCELLED` |
| Investment | `Investment.status` | `CONFIRMED` (submit is synchronous; you'll rarely see `PENDING` / `FAILED`) |
| Distribution | `ProfitDistribution.status` | `PENDING` (building Merkle tree / posting on-chain — claims not ready) → `COMPLETED` (claimable) / `FAILED` |
| Claim | `DistributionClaim.status` | `PENDING` (claimable, show button) → `CLAIMED` (done) |

## Error handling conventions

- **Standard Nest HTTP exceptions** with `{ statusCode, message, error }` bodies:
  `400` (validation/bad state), `401` (bad/missing/expired JWT or wallet signature),
  `403` (role or KYC gate failed), `404` (not found / not yours), `409` (conflicting
  state — campaign not investable, NIK already used, claim already claimed).
- **`ValidationPipe` `whitelist`** strips unknown body fields and coerces types —
  don't rely on the backend rejecting extra fields, but do send correctly typed
  values (numbers as numbers, money as strings).
- **Any `/prepare` → sign → `/submit` failure is safe to retry from `/prepare`** —
  nothing persists until submit succeeds.
