# Creon — Demo Video Script

> **Creon** — web3 crowdfunding (*urun dana*) for Indonesian UMKM on Stellar/Soroban.
> Entrepreneurs raise USDC from KYC'd investors; returns flow back as on-chain
> **dividends (*bagi hasil*)** — not a token-price play — with each investor's share
> fixed by an on-chain Merkle root the platform cannot forge.

**Submission:** Stellar APAC Hackathon 2026
**Format:** pre-recorded screen capture of the Creon web UI, intercut with Stellar
Expert (testnet) to prove on-chain state.
**Language:** English narration; Indonesian domain terms (*bagi hasil*, *urun dana*,
UMKM, NIK) kept on-screen for local authenticity.
**Target length:** ~2.5–3 minutes.
**Cast (three personas):** **Entrepreneur** (UMKM owner), **Investor**, **Admin**
(platform reviewer).

---

## 0. Read this first — what is real vs. narrated

Keep the demo honest; judges will check. On testnet (all 9 core flows verified
end-to-end 2026-07-03, automatic unlock verified 2026-07-04):

- ✅ **Verified on-chain:** a non-whitelisted `invest()` **reverts**; a whitelisted
  `invest()` receives shares via gated `mint`; a **forged Merkle proof on `claim()`
  is rejected**; **milestone release** (share-weighted vote → sequential on-chain
  `release_milestone`); **refund** (admin `cancel()` freezes the contract →
  Merkle `refund_claim` returns principal); **automatic unlock** (time-triggered
  `unlock()` with zero admin/user action). Everything narrated is real — but in
  this short cut the **refund** and **auto-unlock** are *narrated over* status
  shots rather than walked through live (no time for a second full flow).
- ⚠️ The milestone + refund paths require campaigns deployed from the **re-uploaded**
  Campaign WASM (`d867b498…`, uploaded 2026-07-03). Campaigns deployed before that
  date run the old WASM (`462eb8f0…`) and lack these entrypoints — deploy fresh
  campaigns during the dry-run.
- Source of truth for addresses is `contracts/deployments/testnet.json` (below), **not**
  the older address in `SMART_CONTRACT_PLAN.md`.

---

## 1. Pre-record setup checklist (do once, before filming)

Because the whole video is pre-recorded, do a full dry-run first so every contract
address and tx hash you point the camera at already exists.

**Infra + backend**
- [ ] `docker compose up -d` (Postgres, Valkey, MinIO + bucket init)
- [ ] `pnpm prisma:generate` → `pnpm prisma:migrate` → `pnpm db:seed`
- [ ] `pnpm start:dev` → backend on `http://localhost:3000`
- [ ] Frontend running and pointed at that backend

**Keys & accounts** (the seeded wallets are placeholders that *cannot* sign — you must
use real keypairs)
- [ ] `STELLAR_PLATFORM_SECRET` is set **and friendbot-funded** on testnet (owner of
      every contract; pays deploy + fee-bumps + `set_distribution`)
- [ ] Create + friendbot-fund a testnet keypair for the **Entrepreneur**; register it
- [ ] Create + friendbot-fund a testnet keypair for the **Investor**; register it
- [ ] Fund the Investor with testnet **USDC** (SAC `CA6NVKD2…`) so `invest()` succeeds
- [ ] A working **Admin**: ADMIN is not self-registerable — insert/seed a `User` row
      whose `walletAddress` is a real key you control

**Dry-run once** (produces the real hashes you'll show)
- [ ] Onboard → approve KYC → proposal → approve/deploy → invest → milestone vote +
      release → deposit profit → claim, end to end. Save the contract addresses + tx
      hashes for the explorer cutaways. (Campaigns must be deployed fresh — only
      campaigns from the 2026-07-03 WASM `d867b498…` have the milestone/refund
      entrypoints. `scripts/e2e/` has reusable funded wallets + a full-flow driver.)

---

## 2. Storyboard (scene by scene)

Each row: what's on screen → what you click → what to say → the endpoint + on-chain
effect behind it (for a lower-third caption or B-roll).

**Pacing rule for the short cut:** only **three explorer cutaways** in the whole
video — registry `add` (Scene 1), `invest` (Scene 3), `claim` (Scene 5). Everything
else is shown as UI status changes so the pace never drags.

### Scene 0 — Cold open · the problem (~0:00–0:20)
- **On screen:** Title card "Creon — *urun dana* for UMKM, on Stellar." Then three
  big stat callouts: **63 million UMKM · 61% of GDP · 97% of jobs** (all three stay
  on-screen; only the first two are spoken).
- **Action:** Hold on the title; land the stats; cut to a live campaign card.
- **Narration:** *"UMKM—Indonesia's micro and small businesses—are the backbone of
  the economy: 63 million of them, producing over 60% of GDP. Yet most can't access
  formal financing, and investors who want to help face two trust gaps: 'Will the
  money be used as promised?' and 'Will I actually get my fair share of the profit?'.
  Creon solves both with Stellar smart contracts."*
- **Behind the scenes:** —

### Scene 1 — Wallet + KYC → on-chain whitelist (~0:20–0:50)
- **On screen:** Connect Stellar wallet → KYC form (name, 16-digit **NIK**, ID card +
  selfie upload) → submit. Quick cut to Admin queue → **Approve**. Cut to Stellar
  Expert on the **ComplianceRegistry** contract.
- **Action:** Connect (no password); submit KYC; approve as admin; show the `add`
  invocation on the explorer. **(Cutaway 1 of 3.)**
- **Narration:** *"Users sign in with their Stellar wallet—no passwords—and complete
  KYC tied to Indonesia's national ID, the NIK. When an admin approves, the wallet is
  automatically added to an on-chain compliance registry, so the Soroban contracts
  themselves know who is legally allowed to invest."*
- **Behind the scenes:**
  `POST /auth/challenge` → sign → `POST /auth/register` → `POST /kyc` (idCard +
  selfie, private bucket); `POST /admin/kyc/:userId/approve` → BullMQ orchestrator
  calls `registry.add(wallet)`.
  **Cutaway:** `stellar.expert/explorer/testnet/contract/CDDYCTY4BP7RMNDT5SQQMOHS6FZ5MKVPB4LIVON6MONBD2L6GWCJZ2YF`
  → the `add` invocation.

### Scene 2 — Proposal → approval auto-deploys the contracts (~0:50–1:15)
- **On screen:** Entrepreneur creates a proposal — business name, goal (e.g. 10,000
  USDC), lock period, **milestones that sum to the goal** → Submit. Switch to Admin →
  **Approve**. Campaign status walks `PENDING → … → LIVE` on screen.
- **Action:** Submit; approve; hold on the status walking to LIVE (with the deployed
  contract addresses visible in the UI — no explorer cutaway here).
- **Narration:** *"An entrepreneur submits a proposal with concrete milestones. On
  approval, the backend automatically deploys a dedicated Campaign contract and a
  restricted Share Token on Soroban—no manual setup."*
- **Behind the scenes:**
  `POST /proposals` → `POST /proposals/:id/submit`; `POST /admin/proposals/:id/approve`
  → `campaign-deploy` orchestrator: deploy ShareToken → deploy Campaign →
  `token.set_minter(campaign)` → LIVE. (Campaign WASM `d867b498…`, ShareToken WASM
  `ae06cdbb…`.)

### Scene 3 — Investor funds the campaign · fee-bump (~1:15–1:45)
- **On screen:** Investor opens the live campaign → enters an amount → **Invest** →
  wallet prompts to sign → confirmation shows shares received 1:1 and the raised
  amount ticking up.
- **Action:** Invest; sign; **zoom on the wallet fee section showing the platform
  pays it**. Cut to the `invest()` tx on Stellar Expert. **(Cutaway 2 of 3.)**
- **Narration:** *"Whitelisted investors fund the campaign in USDC and receive
  restricted share tokens one-to-one. The investor signs, but the platform pays the
  network fee with Stellar's fee-bump—users never need to hold XLM."*
- **Behind the scenes:** (relay = prepare → sign → submit)
  `POST /campaigns/:id/investments/prepare {amount}` → sign →
  `POST /campaigns/:id/investments {signedXdr}` (fee-bumped) → `invest()` pulls USDC +
  mints shares.
  **Cutaway:** the `invest()` tx — USDC into custody, `mint` event.

### Scene 4 — Milestone vote → on-chain release (~1:45–2:10)
- **On screen:** Entrepreneur uploads milestone proof; investor casts a
  share-weighted **Approve** vote; the tally settles APPROVED; milestone status flips
  to **RELEASED** with its tx hash visible in the UI.
- **Action:** Submit proof; vote; hold on the status flip (tx hash on screen — no
  explorer cutaway; the refund path is narration only).
- **Narration:** *"Capital isn't released all at once: each milestone needs a
  share-weighted investor vote before the contract releases that tranche—
  sequentially, once, on-chain. And if the business turns bad, an admin can cancel:
  the contract freezes and investors reclaim their remaining principal."*
- **Behind the scenes:** `POST /milestones/:id/submit` (proof), `POST /milestones/:id/vote`
  → vote settles → BullMQ orchestrator calls `release_milestone(index)` (owner-gated,
  sequential, once-only). Refund path (verified 2026-07-03, narrated only):
  `POST /admin/campaigns/:id/cancel` → on-chain `cancel()` freezes `invest` +
  `release_milestone` → `set_refund(root)` → investors `refund_claim()`.

### Scene 5 — Dividends: deposit → Merkle root → claim (*bagi hasil*) (~2:10–2:40)
- **On screen:** Entrepreneur deposits profit; the distribution shows a posted Merkle
  root / status COMPLETED. Cut to the Investor: claimable amount → **Claim** → sign →
  USDC arrives. Cut to the `claim()` tx on Stellar Expert.
- **Action:** Deposit; show the root posted; claim as investor; show the USDC balance
  increase and the on-chain `claim()`. **(Cutaway 3 of 3.)**
- **Narration:** *"Profits come back as 'bagi hasil'—real profit sharing, not a
  token-price play. The backend computes everyone's exact cut, builds a Merkle tree,
  and posts only the root on-chain. When an investor claims, the contract verifies
  the proof and pays the exact USDC share—the platform cannot forge who gets paid."*
- **Behind the scenes:**
  `POST /campaigns/:id/distributions/deposit/prepare` → sign → `.../deposit` →
  orchestrator snapshots `TokenHolding` → Merkle tree → `set_distribution(id, root)`.
  Then `GET /distributions/mine` (proof) → `POST /distributions/:id/claim/prepare` →
  sign → `.../claim` → on-chain `claim()` verifies proof, pays USDC, marks claimed.
  **Cutaway:** the `claim()` tx.

### Scene 6 — Close (~2:40–2:55)
- **On screen:** Recap slate — four icons: **KYC'd security token · Milestone-gated
  release · Merkle dividends · On-chain refund safety net**.
- **Narration:** *"And when the lock period ends, the platform unlocks share
  transfers automatically—no admin, no user action. Creon: transparent, compliant
  crowdfunding for the backbone of Indonesia's economy, all on Stellar. Terima
  kasih."*
- **Behind the scenes:** the `campaign-unlock` orchestrator polls `lockEndAt` and
  calls the owner-only `unlock()` (verified on testnet 2026-07-04, real tx
  `14bc8545…`). Narration only — no cutaway.

---

## 3. Full narration (voiceover, read straight through — ~300 words ≈ 2:10 spoken)

> UMKM—Indonesia's micro and small businesses—are the backbone of the economy:
> 63 million of them, producing over 60% of GDP. Yet most can't access formal
> financing, and investors who want to help face two trust gaps: 'Will the money be
> used as promised?' and 'Will I actually get my fair share of the profit?'. Creon
> solves both with Stellar smart contracts.
>
> Users sign in with their Stellar wallet—no passwords—and complete KYC tied to
> Indonesia's national ID, the NIK. When an admin approves, the wallet is
> automatically added to an on-chain compliance registry, so the Soroban contracts
> themselves know who is legally allowed to invest.
>
> An entrepreneur submits a proposal with concrete milestones. On approval, the
> backend automatically deploys a dedicated Campaign contract and a restricted Share
> Token on Soroban—no manual setup.
>
> Whitelisted investors fund the campaign in USDC and receive restricted share tokens
> one-to-one. The investor signs, but the platform pays the network fee with
> Stellar's fee-bump—users never need to hold XLM.
>
> Capital isn't released all at once: each milestone needs a share-weighted investor
> vote before the contract releases that tranche—sequentially, once, on-chain. And if
> the business turns bad, an admin can cancel: the contract freezes and investors
> reclaim their remaining principal.
>
> Profits come back as 'bagi hasil'—real profit sharing, not a token-price play. The
> backend computes everyone's exact cut, builds a Merkle tree, and posts only the
> root on-chain. When an investor claims, the contract verifies the proof and pays
> the exact USDC share—the platform cannot forge who gets paid.
>
> And when the lock period ends, the platform unlocks share transfers automatically—
> no admin, no user action. Creon: transparent, compliant crowdfunding for the
> backbone of Indonesia's economy, all on Stellar. Terima kasih.

---

## 4. On-chain proof appendix (what to type on camera)

**Explorer URL formats (testnet):**
- Contract: `https://stellar.expert/explorer/testnet/contract/<C-ADDRESS>`
- Transaction: `https://stellar.expert/explorer/testnet/tx/<TX-HASH>`
- Account: `https://stellar.expert/explorer/testnet/account/<G-ADDRESS>`

**Real deployed artifacts** (`contracts/deployments/testnet.json`):

| Item | Value |
|------|-------|
| Network | testnet (`Test SDF Network ; September 2015`) |
| Platform owner / deployer | `GDXTJXOSJOEHZ6VLIYB35ON2YM3FYH6AYIFJ7YHFNCANALD35HTXZ6MR` |
| **ComplianceRegistry** (live singleton) | `CDDYCTY4BP7RMNDT5SQQMOHS6FZ5MKVPB4LIVON6MONBD2L6GWCJZ2YF` |
| **ShareToken** WASM hash | `ae06cdbb78077ef8557d86778ffe5a2a2f5d08829245b61a76ad8f93944571fb` |
| **Campaign** WASM hash | `d867b498f35a28ace0a8f7d0195b92bd25549eb473703f352a4d74840684bf7b` (re-uploaded 2026-07-03: adds milestone constructor + refund path; old `462eb8f0…` is stale) |
| **USDC** (test SAC) | `CA6NVKD2EVIK73B4YH6JO4XKA2GLGTN222VTOGXAZVNT5QHKLAT3O7N3` |

Per-campaign ShareToken + Campaign instances are deployed from those WASM hashes at
approval time — capture *their* addresses during the dry-run.

**Merkle trust-vector command** (*optional cutaway — cut from the 3-minute flow;
useful for Q&A or a longer edit*; run from `contracts/`):
```bash
cargo test -p campaign print_merkle_test_vector -- --nocapture
```
Prints the fixed test leaves + root the on-chain `claim()` verifies against — proof the
off-chain tree and the contract can't drift.

**Contract security matrix (on-screen table, from `contracts/README.md`):**
- `ComplianceRegistry.add/remove` — owner-only; the single KYC gate.
- `ShareToken.mint` / `transfer` — recipient must be whitelisted → a share can never
  land in a non-KYC'd wallet, by mint *or* transfer (permissioned security token).
- `Campaign.invest` — whitelist-gated, USDC into custody, shares 1:1.
- `Campaign.release_milestone` — owner-only, sequential, only after fully funded.
- `Campaign.claim` — verifies Merkle proof on-chain, pays once per `(id, index)`.
- `Campaign.cancel` / `set_refund` / `refund_claim` — owner-only cancel **freezes**
  `invest` + `release_milestone`; refunds are Merkle-proven pro-rata of remaining custody.
- `ShareToken.unlock` — owner-only, auto-triggered by the backend when the lock elapses.

---

## 5. Recording tips

- **Add English Subtitles (Closed Captions):** Since you are keeping local terms like UMKM, *urun dana*, and *bagi hasil* for authenticity, clear English subtitles on the video are crucial for international judges.
- **Zoom** on JSON responses and explorer pages — judges want to see the real ledger.
- **Highlight the Fee-Bump:** When mentioning the platform pays the fee in Scene 3, explicitly zoom in or add a visual highlight box around the fee section in the wallet UI.
- Keep a **lower-third caption** with the endpoint name for each UI action.
- Show the Indonesian terms as on-screen text: *urun dana*, *bagi hasil*, UMKM, NIK.
- Pre-open the **three** explorer cutaway tabs (registry `add`, `invest()`, `claim()`)
  to the exact tx/contract pages so there's no loading dead air.
- **Make the stats land in Scene 0:** show *63 million UMKM · 61% of GDP · 97% of jobs*
  as on-screen text — international judges won't know UMKM dominate the economy
  unless you show it.
- **The short cut lives or dies on transitions:** pre-stage each persona in its own
  browser profile/window so switching Entrepreneur → Admin → Investor is one cut,
  not a login.
- End on the recap slate held long enough to read.

## 6. Pre-flight checklist (tick before the take)

- [ ] Backend up, frontend connected, all dry-run hashes saved
- [ ] The 3 explorer cutaway tabs pre-loaded: registry `add`, `invest()`, `claim()`
- [ ] Milestone RELEASED status (with tx hash) reproducible in the UI for Scene 4
- [ ] Investor funded with testnet USDC; platform key funded
- [ ] Mic + screen capture levels checked; captions ready
