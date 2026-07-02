# Frontend Integration Flows

This document outlines what the frontend needs to implement to integrate seamlessly with the `creon-backend`. It focuses on **user actions** and **Wallet signatures** rather than internal service architecture (for that, please refer to `ARCHITECTURE.md`). For full request and response schemas, see `openapi.yaml`. Think of this guide as the "why" and "in what order."

## Core Concepts (Read This First)

**Wallet Authentication (No Passwords).** Identity is tied to a Stellar keypair. You will need a Wallet integration (such as Freighter, xBull, or any compatible signer) capable of:
1. Returning the public key (`G...`, 56 characters).
2. Signing a raw UTF-8 message → returning a base64 signature (used for authentication).
3. Signing a base64 XDR transaction envelope → returning a signed base64 XDR (used for on-chain actions).

**JWT.** Every authenticated API call requires an `Authorization: Bearer <token>` header. This token is minted during registration/login, contains `{ sub: userId, roles: Role[] }`, and expires in **7 days** (`JWT_EXPIRES_IN`). There is no refresh endpoint — once it expires, prompt the user to log in again.

**The Relay Pattern (Prepare → Sign → Submit).** Any action involving the user's USDC or shares (`invest`, `deposit_profit`, `claim`) requires *their* signature, as the smart contract enforces `require_auth()`. The platform cannot sign on their behalf. Therefore, these actions always follow a three-step process:
1. `POST .../prepare` → The backend returns `{ xdr }` (unsigned, source = user's Wallet).
2. The Wallet signs that **exact** XDR (do not modify it!) → returns the signed XDR.
3. `POST .../submit` with `{ signedXdr }` → The backend verifies that the decoded call matches expectations (contract, function, args, caller), **covers the network fee using the platform account (fee-bump)**, submits the transaction, and records the result.

*Consequences:* The **user never pays network fees** and does not need any XLM — they only need USDC (and a Wallet that supports signing Soroban `invoke` transactions). Submit endpoints are **idempotent**: resubmitting the exact same signed XDR will return the already recorded database row instead of triggering a double-submit.

**Roles.** A user can be an `ENTREPRENEUR`, an `INVESTOR`, or both. The `ADMIN` role is for seeded accounts only and should never be exposed during registration. **KYC is per-user, not per-role** — a single KYC submission covers both roles.

**Two Independent Approval Gates.** KYC approval (identity verification) and Campaign approval (Proposal review) are distinct admin actions with separate statuses. Ensure your UI does not conflate the two.

---

## Flow 1 — Register / Login (Wallet Signature Auth)

Both registration and login use the exact same challenge-response flow; only the final endpoint differs.

**Steps:**
1. Request a challenge payload for the user's Wallet address.
2. The Wallet signs the returned `message` **as raw bytes** (this is a message signature, *not* a transaction) → `signatureB64`.
3. Call **register** (for new users) or **login** (for returning users) using the signature → `accessToken`.
4. Store the token securely and attach `Authorization: Bearer <token>` to all subsequent requests.

**Endpoints:**

| Step | Method + Path | Body → Returns |
|---|---|---|
| 1 | `POST /auth/challenge` | `{ walletAddress }` → `{ message }` (fixed-format multi-line string) |
| 3a | `POST /auth/register` | `{ walletAddress, signature, role, email?, displayName? }` → `{ accessToken }` |
| 3b | `POST /auth/login` | `{ walletAddress, signature }` → `{ accessToken }` |

**Caveats:**
- **The challenge is single-use and expires in 5 minutes** (`AUTH_CHALLENGE_TTL_SECONDS`). Prompt the user to sign promptly. If register/login fails with a `401`, request a fresh challenge.
- **`role` must be either `ENTREPRENEUR` or `INVESTOR`** (derive this from the onboarding path the user selected). The `email` field is **required if the role is ENTREPRENEUR**, but optional otherwise.
- **One registration per Wallet.** There is no "add role" endpoint. In the UI, treat each Wallet as a single unified account.
- **`login` is not role-restricted.** Any registered Wallet (including a seeded admin) can log in via this endpoint.

---

## Flow 2 — KYC Submission & Approval

This is a purely off-chain submission. The process is identical for both Entrepreneurs and Investors (access is gated by role via `@Roles`).

**Steps:**
1. Submit identity fields along with ID card and selfie images (multipart form data).
2. Poll the status until an admin makes a decision (there are no push notifications or webhooks for this).

**Endpoints:**

| Step | Method + Path | Body → Returns |
|---|---|---|
| 1 | `POST /kyc` (multipart) | fields: `fullName`, `nationalId` (16-digit NIK), `dateOfBirth?` (YYYY-MM-DD); files: `idCard`, `selfie` (jpeg/png, ≤5MB) → `{ status: "PENDING", submittedAt }` |
| 2 | `GET /kyc/me` | → `{ status: "PENDING" \| "APPROVED" \| "REJECTED" \| "REVOKED", ... }` |

**Caveats:**
- **`nationalId` must be globally unique.** If it's already in use, the API returns `409 Conflict`. Handle this gracefully in the UI (e.g., "This ID has already been used to verify a different account.").
- **Resubmitting while PENDING or REJECTED** will overwrite the existing profile (upsert) and reset the status to `PENDING`.
- **Poll `GET /kyc/me`** (e.g., every 10–30s while `PENDING`) or simply advise the user to check back later.
- **Downstream endpoints will return `403` until the KYC is APPROVED** (enforced by `ApprovedEntrepreneurGuard` / `ApprovedInvestorGuard`). Show a friendly "Please verify your identity first" UI state instead of a raw `403` error screen.
- **`REVOKED`** means an admin revoked a previously approved KYC. This blocks access just like `REJECTED`, but your UI copy should reflect the difference ("Your verification was revoked" vs. "Your submission was rejected").

**Admin Side** (Only if you are building the Admin UI): `GET /admin/kyc?status=PENDING`, `POST /admin/kyc/:userId/approve`, `.../reject { reason }`, `.../revoke { reason }`.
Approving or revoking triggers an async on-chain whitelist sync. While the KYC `status` updates immediately, an Investor's actual ability to invest depends on the on-chain whitelist sync completing (see Flow 4 caveats).

---

## Flow 3 — Entrepreneur: Submit a Funding Proposal

This process is entirely off-chain (no smart contracts involved yet). All write routes require `ApprovedEntrepreneurGuard` (meaning the user has the role + `APPROVED` KYC). You should gate the "New Proposal" button in your UI based on `GET /kyc/me`.

**Steps:**
1. Create a Proposal (starts in `DRAFT` status).
2. Edit the Proposal while it remains a `DRAFT` (optional).
3. Submit the Proposal → Status changes from `DRAFT` to `SUBMITTED` (this locks editing).
4. Poll or wait for the admin's decision.

**Endpoints:**

| Step | Method + Path | Notes |
|---|---|---|
| 1 | `POST /proposals` | `{ businessName, businessDescription, category, location?, requestedAmount, lockPeriodDays }` → Returns the Proposal (`DRAFT`) |
| 2 | `PATCH /proposals/:id` | Accepts any subset of the fields above; **only allowed while in `DRAFT` state**. |
| 3 | `POST /proposals/:id/submit` | Updates status: `DRAFT → SUBMITTED`. |
| 4 | `GET /proposals` / `GET /proposals/:id` | Returns only the caller's own Proposals (`404` if it belongs to someone else). |

**Caveats:**
- **`requestedAmount` must be a string** (e.g., `"1500.5000000"`, up to 7 decimals). Never send a standard JS `number` for financial values anywhere in this API.
- **`lockPeriodDays` is an integer between 1–3650**. This dictates the on-chain principal-lock duration after deployment. Ensure the UI clarifies this ("Principal will be locked for X days after the Campaign goes live").
- **`SUBMITTED` state is read-only** for the Entrepreneur. Poll `GET /proposals/:id` and watch the `status` transition to `UNDER_REVIEW` → `APPROVED` / `REJECTED`.

---

## Flow 4 — Campaign Auto-Deploy (System-Driven, No User Action)

When an admin approves a Proposal (`POST /admin/proposals/:id/approve`), the backend synchronously creates a `Campaign` database record and **asynchronously** deploys the necessary smart contracts (`ShareToken` + `Campaign`, wires `set_minter`, and pushes it live). This takes anywhere from a few seconds to a couple of minutes. The frontend does not need to trigger anything.

**Steps:**
1. Once a Proposal is `APPROVED`, poll `GET /campaigns/:id` (this endpoint is public, no auth required).
2. Watch `deployStatus`: `PENDING → DEPLOYING_TOKEN → DEPLOYING_CAMPAIGN → WIRING → LIVE` (or `FAILED`).
3. Enable the "Invest" button in the UI only when `deployStatus === "LIVE"` **and** `status === "ACTIVE"`.

**Endpoints:**

| Method + Path | Notes |
|---|---|
| `GET /campaigns` | Public; returns **LIVE** Campaigns only. |
| `GET /campaigns/:id` | Public; poll both `deployStatus` and `status` here. |

**Caveats:**
- **Gate the "Invest" action on both `deployStatus === "LIVE"` and `status === "ACTIVE"`** — do not rely solely on the presence of a `contractAddress`. Otherwise, the invest-prepare endpoint will throw a `409 Conflict`.
- **Investor Whitelist Ordering (Crucial):** An Investor's Wallet must be registered in the on-chain compliance registry before `invest()` will succeed. This happens automatically via an async background job after their KYC is approved, tracked internally as `KycProfile.whitelistStatus` (`NOT_SYNCED → ADDING → WHITELISTED`) — **which is not currently exposed on `GET /kyc/me`**. If an Investor attempts to invest immediately after KYC approval and it fails, the on-chain sync likely hasn't finished yet. Show a "Please try again in a moment" message rather than a hard system error.

---

## Flow 5 — Investor: Invest in a Campaign

This utilizes the Relay Pattern (see Core Concepts). It requires the `INVESTOR` role + approved KYC (`ApprovedInvestorGuard`), and the Campaign must be `LIVE/ACTIVE`.

**Steps:**
1. `prepare` the investment with a specific amount → Returns `{ campaignId, xdr }`.
2. Wallet signs the XDR.
3. `submit` the signed XDR → Results in a confirmed `Investment` (synchronous, no polling required).
4. Read the user's holdings/history as needed.

**Endpoints:**

| Step | Method + Path | Body → Returns |
|---|---|---|
| 1 | `POST /campaigns/:campaignId/investments/prepare` | `{ amount }` → `{ campaignId, xdr }` |
| 3 | `POST /campaigns/:campaignId/investments` | `{ signedXdr }` → `Investment { id, campaignId, amount, lpTokens, txHash, status, investedAt }` |
| 4 | `GET /investments/mine` | The caller's historical purchase ledger. |
| 4 | `GET /holdings/mine` | **Live** on-chain-derived balances. |

**Caveats:**
- **`amount` must be in USDC, formatted as a string, up to 7 decimals, and > 0.**
- **Shares (`lpTokens`) are minted 1:1 with USDC** exactly at the time of confirmation.
- **The Wallet needs a USDC trustline and sufficient balance before calling `prepare`.** The backend does not pre-validate this; the smart contract will reject the transaction upon `submit`. Make sure your UI handles and communicates this clearly.
- **Shares are strictly non-transferable during the lock period** (Restricted SEP-41). Do not build any UI for selling or transferring shares.
- **`status` transitions to `CONFIRMED` immediately upon a successful submit** (the submit process is synchronous — no polling is needed here, unlike the deploy process).
- **For displaying portfolio/ownership, prioritize `GET /holdings/mine`** over summing up the results of `/investments/mine`. The latter is just a transaction history, while the former represents actual current ownership.

---

## Flow 6 — Entrepreneur: Distribute Dividends (Deposit Profit)

This utilizes the Relay Pattern. It requires the `ENTREPRENEUR` role + approved KYC, and the caller must be the owner of the Campaign (enforced by `proposal.entrepreneurId`).

**Steps:**
1. `prepare` the deposit with the profit amount → Returns `{ campaignId, xdr }`.
2. Wallet signs the XDR.
3. `submit` → Returns **immediately** with `status: "PENDING"`.
4. Poll the distribution until `status === "COMPLETED"` (a background job builds the Merkle snapshot and posts `set_distribution` on-chain) **before** notifying Investors that dividends are ready to claim.

**Endpoints:**

| Step | Method + Path | Body → Returns |
|---|---|---|
| 1 | `POST /campaigns/:campaignId/distributions/deposit/prepare` | `{ amount }` → `{ campaignId, xdr }` |
| 3 | `POST /campaigns/:campaignId/distributions/deposit` | `{ signedXdr }` → `ProfitDistribution { id, onchainId, totalAmount, status: "PENDING", ... }` |
| 4 | `GET /campaigns/:campaignId/distributions` | Lists all distributions for a Campaign (public). |

**Caveats:**
- **`amount` is the USDC profit, formatted as a string, > 0.** The Wallet needs sufficient USDC balance and a trustline (same caveat as investing).
- **The submit endpoint returns PENDING because the on-chain heavy lifting is async.** You must poll until it hits `COMPLETED`. A `PENDING` distribution has no claim data available yet.
- **`totalShares`, `rewardPerShare`, and `merkleRoot` are populated only after the background job finishes.** Treat these fields as absent/loading while the status is `PENDING`.
- **Entitlements are snapshot automatically based on current share holders at the exact time the deposit is confirmed** (calculated via integer-floor pro-rata). There is no "eligible as of" date to manage on the frontend; it is handled natively.

---

## Flow 7 — Investor: Claim a Dividend

This utilizes the Relay Pattern. It requires the `INVESTOR` role + approved KYC.

**Steps:**
1. Fetch the user's entitlements to find claimable rows.
2. `prepare` a claim for a specific distribution → Returns `{ distributionId, xdr }`.
3. Wallet signs the XDR.
4. `submit` → Updates to `status: "CLAIMED"`; the USDC is deposited directly into the Wallet on-chain.

**Endpoints:**

| Step | Method + Path | Body → Returns |
|---|---|---|
| 1 | `GET /distributions/mine` | `DistributionClaim[] { id, distributionId, amount, status, distribution: { onchainId, campaignId, status } }` |
| 2 | `POST /distributions/:distributionId/claim/prepare` | (No body) → `{ distributionId, xdr }` |
| 4 | `POST /distributions/:distributionId/claim` | `{ signedXdr }` → `DistributionClaim { ..., status: "CLAIMED", claimTxHash, claimedAt }` |

**Caveats:**
- **Show the "Claim" button only when the claim's `status === "PENDING"` AND its parent `distribution.status === "COMPLETED"`.** The `prepare` endpoint will throw a `409 Conflict` if the Merkle root hasn't been posted yet (meaning the distribution is still `PENDING`) or if there is no entitlement row (e.g., the user held zero shares at the time of the snapshot; in which case, it simply won't appear in `/distributions/mine`).
- **Claiming has no expiration.** Unclaimed dividends remain claimable indefinitely (there is no reclaim mechanism). Do not implement any "expires in X days" messaging.
- **The `amount` is fixed.** It is dictated by the server-side Merkle tree. Investors cannot choose to claim a partial amount.
- **There is no separate "withdraw" step.** Upon successful claim submission, the USDC lands straight into the Wallet.

---

## Status Field Cheat-Sheet

A quick reference for what to poll and what each status means (highly useful for managing loading and empty states in the UI).

| Entity | Field | What it means for the Frontend |
|---|---|---|
| KYC | `KycProfile.status` | `PENDING` (wait) → `APPROVED` (unlocked) / `REJECTED` / `REVOKED` (blocked, prompt resubmit) |
| Proposal | `Proposal.status` | `DRAFT` (editable) → `SUBMITTED` → `UNDER_REVIEW` → `APPROVED` / `REJECTED` |
| Campaign | `Campaign.deployStatus` | `PENDING`…`WIRING` (show loading state) → `LIVE` (ready to use) / `FAILED` |
| Campaign | `Campaign.status` | `PENDING_DEPLOYMENT` → `ACTIVE` (ready for investment) → `LOCKED` / `GOAL_REACHED` / `COMPLETED` / `CANCELLED` |
| Investment | `Investment.status` | `CONFIRMED` (submit is synchronous; you will rarely ever see `PENDING` or `FAILED`) |
| Distribution | `ProfitDistribution.status` | `PENDING` (building Merkle tree/posting on-chain — claims are not ready yet) → `COMPLETED` (ready to claim) / `FAILED` |
| Claim | `DistributionClaim.status` | `PENDING` (claimable, show the button) → `CLAIMED` (done) |

## Error Handling Conventions

- **Standard Nest HTTP Exceptions:** Expect responses formatted as `{ statusCode, message, error }`.
  - `400`: Validation error or bad request state.
  - `401`: Missing, invalid, or expired JWT / Wallet signature.
  - `403`: Role check or KYC gate failed.
  - `404`: Resource not found (or does not belong to the caller).
  - `409`: Conflicting state (e.g., Campaign not investable, NIK already used, claim already fulfilled).
- **`ValidationPipe` Whitelist:** The backend automatically strips unknown body fields and enforces type coercion. Do not rely on the backend to reject extra payload fields, but **make absolutely sure** you are sending correctly typed values (numbers as `number`, money as `string`).
- **Safe Retries:** Any failure within the `/prepare` → sign → `/submit` loop is completely safe to retry starting from `/prepare`. Nothing is persisted to the database or blockchain until the `/submit` call succeeds.