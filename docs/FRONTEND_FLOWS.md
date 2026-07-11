# Frontend Integration Flows

This document outlines what the frontend needs to implement to integrate seamlessly with the `creon-backend`. It focuses on **user actions** and **Wallet signatures** rather than internal service architecture (for that, please refer to `ARCHITECTURE.md`). For full request and response schemas, see `openapi.yaml`. Think of this guide as the "why" and "in what order."

## Core Concepts (Read This First)

**Wallet Authentication (No Passwords).** Identity is tied to a Stellar keypair. You will need a Wallet integration (such as Freighter, xBull, or any compatible signer) capable of:
1. Returning the public key (`G...`, 56 characters).
2. Signing a UTF-8 message using SEP-53 → returning a base64 signature (used for authentication).
3. Signing a base64 XDR transaction envelope → returning a signed base64 XDR (used for on-chain actions).

**JWT.** Register/login set the JWT as an **httpOnly cookie** (`creon_access_token`) — it is never returned in the response body and cannot be read from JS. The token is minted during registration/login, contains `{ sub: userId, roles: Role[] }`, and expires in **7 days** (`JWT_EXPIRES_IN`); the cookie's `Max-Age` matches. Every authenticated request must be sent with credentials so the browser attaches the cookie automatically — `fetch(url, { credentials: 'include' })` or an axios instance with `withCredentials: true`. There is no refresh endpoint — once it expires, prompt the user to log in again. `POST /auth/logout` clears the cookie (safe to call even if already expired/absent).

**Response Envelope.** Every JSON response is wrapped in a consistent shape. Success: `{ statusCode, message, data }` — `data` holds exactly the payload shown in the "Returns" column below (unchanged in shape); `message` is a short, human-readable, per-endpoint string not meant for branching logic (branch on `statusCode` / `data` instead). Errors: `{ statusCode, message, error, data: null }` — same `message`/`error` as before, now always paired with `data: null`. The one exception is `204 No Content` (`POST /auth/logout`), which still has a completely empty body.

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
2. The Wallet signs the returned `message` using **SEP-53** (this is a message signature, *not* a transaction) → `signatureB64`.
3. Call **register** (for new users) or **login** (for returning users) using the signature — the JWT is set as an httpOnly cookie, and the body returns the authenticated principal (`{ userId, roles }`).
4. Make sure the request that called register/login (and every request after it) is sent with credentials (`credentials: 'include'` / `withCredentials: true`) so the cookie is stored and re-sent automatically. No client-side token storage needed or possible.

**Endpoints:**

| Step | Method + Path | Body → Returns (in `data`) |
|---|---|---|
| 1 | `POST /auth/challenge` | `{ walletAddress }` → `{ message }` (fixed-format multi-line string) |
| 3a | `POST /auth/register` | `{ walletAddress, signature, role, email?, displayName? }` → `{ userId, roles }` (+ `Set-Cookie: creon_access_token`) |
| 3b | `POST /auth/login` | `{ walletAddress, signature }` → `{ userId, roles }` (+ `Set-Cookie: creon_access_token`) |
| — | `POST /auth/logout` | *(no body)* → `204`, clears the cookie |

**Caveats:**
- **The challenge is single-use and expires in 5 minutes** (`AUTH_CHALLENGE_TTL_SECONDS`). Prompt the user to sign promptly. If register/login fails with a `401`, request a fresh challenge.
- **Authentication signatures must use SEP-53**: sign `SHA-256("Stellar Signed Message:\n" + UTF-8(message))`, not the raw message bytes.
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

| Step | Method + Path | Body → Returns (in `data`) |
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
| 1 | `POST /proposals` | `{ businessName, businessDescription, category, location?, requestedAmount, lockPeriodDays, milestones }` → Returns the Proposal (`DRAFT`) |
| 2 | `PATCH /proposals/:id` | Accepts any subset of the fields above; **only allowed while in `DRAFT` state**. |
| 3 | `POST /proposals/:id/submit` | Updates status: `DRAFT → SUBMITTED`. |
| 4 | `GET /proposals` / `GET /proposals/:id` | Returns only the caller's own Proposals (`404` if it belongs to someone else). |

**Caveats:**
- **`requestedAmount` must be a string** (e.g., `"1500.5000000"`, up to 7 decimals). Never send a standard JS `number` for financial values anywhere in this API.
- **`lockPeriodDays` is an integer between 1–3650**. This dictates the on-chain principal-lock duration after deployment. Ensure the UI clarifies this ("Principal will be locked for X days after the Campaign goes live").
- **`milestones` is required** — an array of `{ order, title, description, amount }`. `order` must start at 1 and be contiguous integers; each `amount` is a money string; all `amount`s must sum **exactly** to `requestedAmount` (validated server-side, `400` on mismatch). These become the on-chain staged-release schedule — see Flow 8 (Milestone Submission & Voting). `PATCH /proposals/:id` can replace the whole milestone set while still `DRAFT`.
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
- **Unlock is fully automatic** — once `Campaign.lockEndAt` passes, a background job calls the on-chain `unlock()` with no admin or user action required. Poll `unlockStatus` on `GET /campaigns/:id`; once it reaches `UNLOCKED`, shares are transferable P2P to any other whitelisted address (this is separate from investing — there is no in-app secondary market/AMM).

---

## Flow 5 — Investor: Invest in a Campaign

This utilizes the Relay Pattern (see Core Concepts). It requires the `INVESTOR` role + approved KYC (`ApprovedInvestorGuard`), and the Campaign must be `LIVE/ACTIVE`.

**Steps:**
1. `prepare` the investment with a specific amount → Returns `{ campaignId, xdr }`.
2. Wallet signs the XDR.
3. `submit` the signed XDR → Results in a confirmed `Investment` (synchronous, no polling required).
4. Read the user's holdings/history as needed.

**Endpoints:**

| Step | Method + Path | Body → Returns (in `data`) |
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

| Step | Method + Path | Body → Returns (in `data`) |
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

| Step | Method + Path | Body → Returns (in `data`) |
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

## Flow 8 — Milestone Submission & Investor Voting

Milestones govern **staged release of the raised principal** — distinct from Flow 6/7, which cover profit dividends. They are authored up front with the Proposal (Flow 3): each has an `order`, `title`, `description`, and `amount`, and the amounts sum exactly to `requestedAmount`. A milestone starts `DRAFT`, flips to `PENDING` once the Campaign deploys, and then progresses through voting as the business executes.

**Steps:**
1. Once the Campaign has reached its funding goal, the Entrepreneur submits the next sequential milestone (multipart, with a proof-of-progress file) → opens a voting window (7 days by default).
2. Investors cast a weighted ballot (`APPROVE`/`REJECT`) — weight is their current share balance. They may change their vote any time before the window closes.
3. When the window closes, a background job tallies the result: **quorum** (30% of the total share supply, snapshotted when voting opened) **and majority** (>50% of cast weight) are both required to approve. On approval, the backend asynchronously drives the on-chain `release_milestone()`.
4. Poll the milestone's `status` until it reaches `RELEASED`.

**Endpoints:**

| Step | Method + Path | Body → Returns (in `data`) |
|---|---|---|
| - | `GET /milestones?campaignId=<uuid>` | Lists a Campaign's milestones, ordered (public read). |
| - | `GET /milestones/:milestoneId` | Detail + running vote tally + the caller's own vote + a presigned `proofUrl`. |
| 1 | `POST /milestones/:milestoneId/submit` (multipart) | Entrepreneur only; file field `proof` (jpeg/png/pdf, ≤5MB) → milestone with `status: "VOTING"` |
| 2 | `POST /milestones/:milestoneId/vote` | Investor only; `{ choice: "APPROVE" \| "REJECT" }` → `{ milestoneId, choice, weight }` |

**Caveats:**
- **`submit` requires the `ENTREPRENEUR` role + approved KYC + ownership of the underlying Proposal.** `vote` requires the `INVESTOR` role + approved KYC + that the caller currently holds shares in the Campaign (`403 Forbidden` — "You hold no shares in this campaign" — otherwise).
- **Submission is gated on full funding and strict order.** The Campaign must have reached its goal (`409 Conflict` — "Campaign has not reached its funding goal yet"), and every lower-order milestone must already be `RELEASED` (`409 Conflict` — "A previous milestone has not been released yet").
- **Quorum has a default-approve safety net.** If quorum is missed, the voting window auto-extends once; if it's still missed after that, the milestone **auto-approves** so a passive electorate can't block fund release indefinitely. Consider surfacing this in the UI ("if turnout stays low, this milestone will be approved automatically after the extended window").
- **Voting closes exactly at the deadline.** A vote submitted after `votingEndsAt` returns `409 Conflict` — "Voting is not open for this milestone".
- **A cancelled Campaign freezes both actions.** Submitting or voting on a `CANCELLED` Campaign's milestone returns `409 Conflict` — "Campaign has been cancelled" (see Flow 9).
- **`MilestoneStatus` cheat-sheet:** `DRAFT` (authored with the Proposal, not yet live) → `PENDING` (Campaign live, awaiting submission) → `VOTING` (ballot open) → `APPROVED` (tallied, release enqueuing — transient) → `RELEASING` (on-chain tx pending) → `RELEASED` (done) / `REJECTED` (vote failed) / `FAILED` (on-chain error).

---

## Flow 9 — Admin: Cancel a Campaign & Investor Refund Claim

For a problematic Campaign (fraud, business failure, etc.), an admin can cancel it. This freezes further on-chain activity (`invest()` and `release_milestone()` both revert afterward) and opens a pro-rata refund of the **remaining custody** (`raised − amount already released to the business via milestones`) back to Investors. It needs no deposit step — the money is already in the contract — but otherwise reuses the exact same prepare → sign → submit relay shape as dividend claims (Flow 7).

**Steps:**
1. *(Admin action, not Investor-facing)* — an admin cancels the Campaign with a reason.
2. Poll `GET /campaigns/:campaignId/refund` until `status === "COMPLETED"` before telling Investors a refund is claimable. This is async: a background job calls on-chain `cancel()`, snapshots holdings, builds a Merkle tree, then posts `set_refund()` on-chain — the same async shape as dividend distribution (Flow 6).
3. The Investor fetches `GET /refunds/mine` to find their entitlement + Merkle proof.
4. `prepare` a claim → Wallet signs the XDR → `submit` → `status: "CLAIMED"`, USDC lands directly in the Wallet.

**Endpoints:**

| Step | Method + Path | Body → Returns (in `data`) |
|---|---|---|
| 2 | `GET /campaigns/:campaignId/refund` | Public → `Refund { id, campaignId, reason, totalAmount, totalShares, totalClaimed, merkleRoot, snapshotLedger, status, createdAt }`, or `null` if the Campaign was never cancelled. |
| 3 | `GET /refunds/mine` | `RefundClaim[] { id, refundId, shareAmount, amount, leafIndex, merkleProof, claimTxHash, status, claimedAt, createdAt, refund: { campaignId, status } }` |
| 4 | `POST /refunds/:refundId/claim/prepare` | (No body) → `{ refundId, xdr }` |
| 4 | `POST /refunds/:refundId/claim` | `{ signedXdr }` → `RefundClaim { ..., status: "CLAIMED", claimTxHash, claimedAt }` |

**Admin Side** (only if you are building the Admin UI): `POST /admin/campaigns/:id/cancel { reason }` (admin-only, returns `200`) → returns the newly opened `Refund` row. Note this response is a **smaller shape** than the read endpoint above — just `{ id, campaignId, reason, status, createdAt }` (the totals aren't computed yet at cancel time). It's idempotent: re-calling on an already-cancelled Campaign just re-enqueues the background job and returns the existing row. Throws `404` if the Campaign doesn't exist, or `409 Conflict` if it's already `CANCELLED`, already `COMPLETED`, or not yet live on-chain (`deployStatus !== "LIVE"`).

**Caveats:**
- **`Campaign.status` flips to `CANCELLED` synchronously**, but the on-chain freeze and refund computation happen asynchronously afterward. Before `Refund.status === "COMPLETED"`, `claim/prepare` throws `409 Conflict` — "Refund is not ready to claim". Show a "refund is being processed" state, not a claim button, in the interim.
- **The refund amount is based on remaining custody, not the original investment.** It's split pro-rata over `raised − already released to the business`, so an Investor whose Campaign had already released several milestones gets back proportionally less than their full principal. Make this explicit in the UI copy — do not imply a full refund.
- **No claim expiration**, same as dividends — unclaimed refunds remain claimable indefinitely.
- **Shares are not burned** after a refund claim. A cancelled Campaign runs no further dividends or milestone releases, so this has no practical effect, but don't build UI that assumes the share balance zeroes out after claiming.
- **Cancellation freezes milestones too** — see Flow 8's cancelled-Campaign guard. If a milestone vote is in flight when a cancellation happens, switch that UI to the refund flow.
- **`claim` submit returns HTTP `201`** (Nest's default), while `claim/prepare` explicitly returns `200`. Don't assume both are `200` if your client branches on status code rather than payload shape.

---

## Flow 10 — Faucet: Get Test USDC (No Login Required)

A self-service faucet so anyone — chiefly hackathon judges — can get test USDC into their own wallet without registering or KYC. Unlike every other flow in this document, **these three endpoints need no JWT** (no cookie, no `Authorization` header) — the wallet address is passed directly in the body.

Test USDC here is a **classic Stellar asset** (not a Soroban contract mint), issued by the platform key. That splits the flow into two different signers:
- `changeTrust` (establishing the trustline) must be signed by the **wallet itself** — one-time per wallet.
- The actual "mint" is a classic `payment` signed only by the **platform** (the issuer) — the caller signs nothing for this part.

**Steps:**
1. Make sure the wallet already has some testnet XLM (Freighter's built-in "Fund with friendbot" button, or visit `https://friendbot.stellar.org?addr=<publicKey>`). This is outside our API — both endpoints below 400 with a clear message if the account doesn't exist on-chain yet.
2. `POST /faucet/usdc/trustline/prepare { walletAddress }` → unsigned `changeTrust` XDR. If the wallet already has the trustline, this 409s — skip straight to step 4.
3. Wallet signs the XDR, then `POST /faucet/usdc/trustline/submit { walletAddress, signedXdr }` → backend fee-bumps and submits it.
4. `POST /faucet/usdc/claim { walletAddress }` → backend sends a fixed amount of test USDC straight from the platform account. No signature needed. Cooldown-limited per wallet (default 24h) — a repeat call within the window 409s.

**Endpoints:**

| Step | Method + Path | Body → Returns (in `data`) |
|---|---|---|
| 2 | `POST /faucet/usdc/trustline/prepare` | `{ walletAddress }` → `{ xdr }` |
| 3 | `POST /faucet/usdc/trustline/submit` | `{ walletAddress, signedXdr }` → `{ txHash }` |
| 4 | `POST /faucet/usdc/claim` | `{ walletAddress }` → `{ txHash, amount, walletAddress }` |

**Caveats:**
- **Fully public** — no auth guard at all (same as `GET /campaigns`). Don't send a bearer token or cookie; it's simply ignored.
- **Step 4 needs no wallet signature** — the payment is entirely platform-signed, since the platform is the asset's issuer. Only the trustline step needs the wallet to sign anything.
- **Cooldown, not a hard cap** — after the cooldown window elapses, the same wallet can claim again.
- **Trustline is required before claiming.** If you skip straight to `/claim` on a fresh wallet, expect a `400` telling you to call `/trustline/prepare` first.

---

## Status Field Cheat-Sheet

A quick reference for what to poll and what each status means (highly useful for managing loading and empty states in the UI).

| Entity | Field | What it means for the Frontend |
|---|---|---|
| KYC | `KycProfile.status` | `PENDING` (wait) → `APPROVED` (unlocked) / `REJECTED` / `REVOKED` (blocked, prompt resubmit) |
| Proposal | `Proposal.status` | `DRAFT` (editable) → `SUBMITTED` → `UNDER_REVIEW` → `APPROVED` / `REJECTED` |
| Campaign | `Campaign.deployStatus` | `PENDING`…`WIRING` (show loading state) → `LIVE` (ready to use) / `FAILED` |
| Campaign | `Campaign.status` | `PENDING_DEPLOYMENT` → `ACTIVE` (ready for investment) → `LOCKED` / `GOAL_REACHED` / `COMPLETED` / `CANCELLED` (admin-cancelled — check `GET /campaigns/:id/refund` for payout status) |
| Campaign | `Campaign.unlockStatus` | `PENDING` (principal lock still active) → `UNLOCKING` (transient) → `UNLOCKED` (shares now P2P-transferable to whitelisted addresses) / `FAILED` (retried automatically) |
| Investment | `Investment.status` | `CONFIRMED` (submit is synchronous; you will rarely ever see `PENDING` or `FAILED`) |
| Distribution | `ProfitDistribution.status` | `PENDING` (building Merkle tree/posting on-chain — claims are not ready yet) → `COMPLETED` (ready to claim) / `FAILED` |
| Claim | `DistributionClaim.status` | `PENDING` (claimable, show the button) → `CLAIMED` (done) |
| Milestone | `Milestone.status` | `DRAFT`/`PENDING` (not yet submitted) → `VOTING` (show ballot UI) → `APPROVED`/`RELEASING` (transient) → `RELEASED` (done) / `REJECTED` / `FAILED` |
| Refund | `Refund.status` | `PENDING` (cancellation in progress, not claimable yet) → `COMPLETED` (ready to claim) / `FAILED` |
| Refund Claim | `RefundClaim.status` | `PENDING` (claimable, show the button) → `CLAIMED` (done) |

## Error Handling Conventions

- **Standard Nest HTTP Exceptions:** Expect responses formatted as `{ statusCode, message, error, data: null }`.
  - `400`: Validation error or bad request state.
  - `401`: Missing, invalid, or expired JWT / Wallet signature.
  - `403`: Role check or KYC gate failed.
  - `404`: Resource not found (or does not belong to the caller).
  - `409`: Conflicting state (e.g., Campaign not investable, NIK already used, claim already fulfilled).
- **`ValidationPipe` Whitelist:** The backend automatically strips unknown body fields and enforces type coercion. Do not rely on the backend to reject extra payload fields, but **make absolutely sure** you are sending correctly typed values (numbers as `number`, money as `string`).
- **Safe Retries:** Any failure within the `/prepare` → sign → `/submit` loop is completely safe to retry starting from `/prepare`. Nothing is persisted to the database or blockchain until the `/submit` call succeeds.
