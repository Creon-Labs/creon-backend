# Frontend Integration Flows

This document explains the flows a frontend needs to implement to work with
`creon-backend`. It's written around *what the user does* and *what the wallet
needs to sign*, not the internal service architecture (see `ARCHITECTURE.md`
for that). Full request/response shapes are in `openapi.yaml` — this doc is
the "why and in what order."

## Core concepts before you start

**Wallet-auth, not passwords.** There's no email/password. Identity = a
Stellar keypair. The frontend needs a Stellar wallet integration (Freighter,
xBull, or any signer that can sign an arbitrary payload / classic tx) that can:
1. Return the user's public key (`G...`, 56 chars).
2. Sign a raw UTF-8 message and return a base64 signature (for auth).
3. Sign a base64 XDR transaction envelope and return the signed base64 XDR
   (for on-chain actions).

**JWT.** Every authenticated call needs `Authorization: Bearer <token>`. The
token is minted at register/login, embeds `{ sub: userId, roles: Role[] }`,
and expires in **7 days** (`JWT_EXPIRES_IN`). There's no refresh endpoint —
when it expires, re-run the login flow (challenge → sign → login).

**The relay pattern (prepare → sign → submit).** Anything that touches the
investor's or entrepreneur's own USDC/shares (`invest`, `deposit_profit`,
`claim`) needs *their* signature — the contract checks `require_auth()` on
that address. The platform can't sign on their behalf. So these actions are
always two calls:
1. `POST .../prepare` → backend builds an unsigned transaction and returns
   `{ xdr }` (base64 XDR, source account = the user's wallet).
2. Frontend has the wallet sign that exact XDR (do not modify it) and gets
   back a signed XDR.
3. `POST .../submit` with `{ signedXdr }` → backend verifies the decoded call
   matches what was expected (contract, function, args, caller), **fee-bumps
   it with the platform account**, submits to the network, and records the
   result.

This means **the user never pays network fees** and never needs XLM in their
wallet — they only need USDC (and a wallet that can sign Soroban invoke
transactions). Submit endpoints are idempotent: retrying with the same signed
XDR returns the already-recorded row instead of erroring or double-submitting.

**Roles.** A user can hold `ENTREPRENEUR`, `INVESTOR`, or both. `ADMIN` is
seed-only — never surfaced at registration. KYC is **per-user, not per-role**:
one KYC submission covers both if the user is registered as both.

**Two independent approval gates.** KYC approval (identity) and campaign
approval (proposal review) are separate admin actions with separate statuses
— don't conflate them in the UI.

---

## Flow 1 — Register / Login (wallet-signature auth)

Same challenge-response mechanism for both; the only difference is which
endpoint you call at the end.

```
1. POST /auth/challenge  { walletAddress }
   -> { message }                      // a fixed-format multi-line string

2. Wallet signs `message` as raw bytes (NOT a transaction — a plain message
   signature) -> signatureB64

3a. New user:
    POST /auth/register { walletAddress, signature, role, email?, displayName? }
    -> { accessToken }

3b. Existing user:
    POST /auth/login { walletAddress, signature }
    -> { accessToken }
```

Notes:
- The challenge is single-use and expires in 5 minutes (`AUTH_CHALLENGE_TTL_SECONDS`)
  — sign and submit promptly, and re-request a fresh challenge if register/login
  fails with 401.
- `role` at register is `ENTREPRENEUR` or `INVESTOR` only (pick based on which
  onboarding flow the user started). `email` is **required when role is
  ENTREPRENEUR**, optional otherwise. A wallet can only register once; to add
  the other role for the same person there is currently no "add role" endpoint
  — treat each wallet as single-role in the UI.
- `login` is not role-restricted — any registered wallet (including a
  DB-provisioned admin) can log in with it.
- Store `accessToken` (e.g. in memory + secure storage); attach as
  `Authorization: Bearer <token>` on every subsequent call.

---

## Flow 2 — KYC submission & approval

Applies identically to entrepreneurs and investors — same endpoint, gated by
role via `@Roles`.

```
POST /kyc   (multipart/form-data, auth required)
  fields: fullName, nationalId (16-digit NIK), dateOfBirth? (YYYY-MM-DD)
  files:  idCard (jpeg/png, ≤5MB), selfie (jpeg/png, ≤5MB)
-> { status: "PENDING", submittedAt }

GET /kyc/me   (auth required)
-> { status: "PENDING" | "APPROVED" | "REJECTED" | "REVOKED", ... }
```

- `nationalId` is globally unique — a second submission with a NIK already
  used by another account gets **409 Conflict**. Surface this as "this ID has
  already been used to verify a different account."
- Resubmitting while PENDING/REJECTED overwrites the profile (upsert) and
  resets status to PENDING.
- **Poll `GET /kyc/me`** after submission to reflect admin's decision — there's
  no push/webhook. A reasonable interval is every 10–30s while status is
  PENDING, or just prompt the user to check back.
- Downstream gating: `ApprovedEntrepreneurGuard` / `ApprovedInvestorGuard`
  block proposal-writes and investment/claim endpoints with **403** until
  `KycProfile.status === APPROVED`. Show a clear "verify your identity first"
  state rather than letting the user hit a raw 403.
- `REVOKED` (admin can revoke a previously-approved KYC) behaves like
  not-approved for all gates — treat it the same as REJECTED in the UI, but
  the copy should probably differ ("your verification was revoked" vs "your
  submission was rejected").

Admin side (for an admin-facing UI, if you're building one):
`GET /admin/kyc?status=PENDING`, `POST /admin/kyc/:userId/approve`,
`POST /admin/kyc/:userId/reject { reason }`, `POST /admin/kyc/:userId/revoke { reason }`.
Approve/revoke each kick off an async on-chain whitelist sync — the KYC
`status` flips immediately, but the *investor's ability to actually invest*
additionally depends on the whitelist landing on-chain (see Flow 4 caveat).

---

## Flow 3 — Entrepreneur: submit a funding proposal

Off-chain only — no contract is touched here.

```
POST   /proposals               { businessName, businessDescription, category,
                                   location?, requestedAmount, lockPeriodDays }
       -> proposal (status: DRAFT)

PATCH  /proposals/:id           (any subset of the above fields)
       -> only allowed while status === DRAFT

POST   /proposals/:id/submit    -> DRAFT -> SUBMITTED (locks editing)

GET    /proposals                -> caller's own proposals
GET    /proposals/:id             -> caller's own proposal (404 if not theirs)
```

- All write routes require `ApprovedEntrepreneurGuard` (role + KYC APPROVED)
  — build the KYC flow first, gate the "New Proposal" button on
  `GET /kyc/me` status.
- `requestedAmount` is a **string** (`"1500.5000000"`-style, up to 7 decimals)
  — never send a JS `number` for money fields anywhere in this API.
- `lockPeriodDays` is an integer 1–3650; this becomes the on-chain lock
  duration once the campaign deploys, so make its meaning clear in the form
  ("investors' principal is locked for this many days after go-live").
- Once SUBMITTED, the proposal is read-only for the entrepreneur; wait for an
  admin decision. There is no proposal detail push — poll `GET /proposals/:id`
  and watch `status` move to `APPROVED`/`REJECTED`, or `UNDER_REVIEW` in
  between.

---

## Flow 4 — Campaign auto-deploy (system-driven, no user action)

When an admin approves a proposal (`POST /admin/proposals/:id/approve`), the
backend synchronously creates a `Campaign` row and **asynchronously** deploys
the on-chain contracts (`ShareToken` + `Campaign`, wiring `set_minter`, then
flipping the campaign live). This can take anywhere from seconds to a couple
minutes and is entirely backend-driven — nothing for the frontend to trigger.

What the frontend does:
- After a proposal is APPROVED, poll `GET /campaigns/:id` (public, no auth)
  and watch `deployStatus` progress:
  `PENDING → DEPLOYING_TOKEN → DEPLOYING_CAMPAIGN → WIRING → LIVE` (or `FAILED`).
- A campaign is only investable once `deployStatus === "LIVE"` **and**
  `status === "ACTIVE"`; the invest-prepare endpoint returns 409 otherwise. Gate
  the "Invest" button on both fields, not just presence of a `contractAddress`.
- Browse endpoints are public and unauthenticated: `GET /campaigns` (only
  returns LIVE ones) and `GET /campaigns/:id`.

**Investor whitelist caveat (important ordering issue):** an investor's wallet
must be added to the on-chain compliance registry before their `invest()` tx
will succeed — this happens automatically after KYC approval via the same
kind of async orchestrator, tracked as `KycProfile.whitelistStatus`
(`NOT_SYNCED → ADDING → WHITELISTED`). This isn't directly exposed on
`GET /kyc/me` today, so in practice: **if an investor's first `invest`
attempt fails right after their KYC was just approved, it's very likely the
whitelist sync hasn't landed yet — show a retry/backoff message rather than a
hard error**, since the contract itself will reject a non-whitelisted
`invest()` call.

---

## Flow 5 — Investor: invest in a campaign

Relay pattern (see Core Concepts). Requires `INVESTOR` role + approved KYC
(`ApprovedInvestorGuard`) and the campaign to be LIVE/ACTIVE.

```
POST /campaigns/:campaignId/investments/prepare   { amount }
  -> { campaignId, xdr }

[wallet signs xdr]

POST /campaigns/:campaignId/investments           { signedXdr }
  -> Investment { id, campaignId, amount, lpTokens, txHash, status, investedAt }

GET  /investments/mine   -> caller's own investment history
```

- `amount` is USDC, string, up to 7 decimals, must be > 0.
- Shares (`lpTokens`) are minted **1:1** with USDC invested at confirm time.
- The investor's wallet needs a USDC trustline and sufficient USDC balance
  *before* preparing — if the invest call fails on submit due to insufficient
  balance/trustline, surface that plainly (the backend doesn't pre-check
  balance, the contract will simply reject the tx).
- Shares are **non-transferable during the lock period** (restricted SEP-41)
  — don't build any "sell/transfer shares" UI; there isn't one.
- `status` on the returned Investment is `CONFIRMED` once submit succeeds
  (submit is synchronous end-to-end — no polling needed here, unlike deploy).
- To show the investor's current portfolio value/ownership, prefer
  `GET /holdings/mine` (live on-chain-derived balances) over summing
  `/investments/mine` — the latter is a historical ledger of purchases, not
  current ownership, and won't reflect balances correctly if the platform
  ever adds a transfer path later.

---

## Flow 6 — Entrepreneur: distribute dividends (deposit profit)

Same relay shape as invest. Requires `ENTREPRENEUR` role + approved KYC, and
the caller must own the campaign (guard checks `proposal.entrepreneurId`).

```
POST /campaigns/:campaignId/distributions/deposit/prepare   { amount }
  -> { campaignId, xdr }

[wallet signs xdr]

POST /campaigns/:campaignId/distributions/deposit           { signedXdr }
  -> ProfitDistribution { id, onchainId, totalAmount, status: "PENDING", ... }

GET  /campaigns/:campaignId/distributions   -> all distributions for a campaign (public)
```

- `amount` is USDC profit being deposited, string, > 0. The entrepreneur's
  wallet needs the USDC to deposit (same trustline/balance caveat as invest).
- The deposit submit call returns **immediately** with `status: "PENDING"` —
  the actual Merkle snapshot build + on-chain `set_distribution` call happens
  **asynchronously** in the background (can take a bit, similar to campaign
  deploy). **Poll `GET /campaigns/:campaignId/distributions` (or track the
  returned `id`) until that distribution's `status` becomes `COMPLETED`**
  before telling investors dividends are claimable — a PENDING distribution
  has no claims to fetch yet.
- `totalShares`/`rewardPerShare`/`merkleRoot` are populated once the
  background job finishes; treat them as absent/loading while PENDING.
- Entitlements are computed by **snapshotting current share holders at the
  moment the deposit confirms** (integer-floor pro-rata) — there is no
  "eligible as of" date the frontend needs to manage; it's automatic.

---

## Flow 7 — Investor: claim a dividend

Relay pattern again. Requires `INVESTOR` role + approved KYC.

```
GET  /distributions/mine   -> caller's own entitlements across all campaigns
  -> DistributionClaim[] { id, distributionId, amount, status, distribution: { onchainId, campaignId, status } }

POST /distributions/:distributionId/claim/prepare   (no body)
  -> { distributionId, xdr }

[wallet signs xdr]

POST /distributions/:distributionId/claim           { signedXdr }
  -> DistributionClaim { ..., status: "CLAIMED", claimTxHash, claimedAt }
```

- Only show a "Claim" button when the claim's `status === "PENDING"` **and**
  its nested `distribution.status === "COMPLETED"` — prepare will 409 if the
  distribution's Merkle root hasn't been posted on-chain yet (still PENDING),
  or if there's simply no entitlement row for that user (they held zero
  shares at snapshot time — `GET /distributions/mine` just won't list it).
- Claiming is **not time-limited** — unclaimed dividends stay claimable
  indefinitely (the contract has no expiry/reclaim), so there's no "expires
  in X days" messaging needed.
- `amount` on the claim is the investor's fixed entitlement in USDC —
  it's pinned by the Merkle tree server-side, the investor can't choose a
  partial amount.
- After a successful claim, USDC lands directly in the investor's wallet
  on-chain — no separate "withdraw" step.

---

## Status field cheat-sheet

Quick reference for what to poll and what each value means, for building
loading/empty states without re-reading the backend source.

| Entity | Field | Frontend-relevant values |
|---|---|---|
| KYC | `KycProfile.status` | `PENDING` (wait) → `APPROVED` (unlocked) / `REJECTED` / `REVOKED` (blocked, resubmit) |
| Proposal | `Proposal.status` | `DRAFT` (editable) → `SUBMITTED` → `UNDER_REVIEW` → `APPROVED` / `REJECTED` |
| Campaign | `Campaign.deployStatus` | `PENDING`…`WIRING` (show "deploying") → `LIVE` (usable) / `FAILED` |
| Campaign | `Campaign.status` | `PENDING_DEPLOYMENT` → `ACTIVE` (investable) → `LOCKED`/`GOAL_REACHED`/`COMPLETED`/`CANCELLED` |
| Investment | `Investment.status` | `CONFIRMED` (submit is synchronous; you'll rarely see `PENDING`/`FAILED`) |
| Distribution | `ProfitDistribution.status` | `PENDING` (building Merkle tree / posting on-chain — claims not ready) → `COMPLETED` (claimable) / `FAILED` |
| Claim | `DistributionClaim.status` | `PENDING` (claimable, show button) → `CLAIMED` (done) |

## Error handling conventions

- All errors are standard Nest HTTP exceptions with `{ statusCode, message, error }`
  JSON bodies — `400` (validation/bad state), `401` (bad/missing/expired JWT
  or wallet signature), `403` (role or KYC gate failed), `404` (not found /
  not yours), `409` (conflicting state, e.g. campaign not investable, NIK
  already used, claim already claimed).
- `whitelist` (`ValidationPipe`) strips unknown body fields and coerces types
  — don't rely on the backend rejecting extra fields, but do send correctly
  typed values (numbers as numbers, money as strings).
- For any `/prepare` → sign → `/submit` flow, a failure on submit (bad
  signature, wrong contract/function/args, insufficient balance) is safe to
  retry from `/prepare` again — nothing is persisted until submit succeeds.
