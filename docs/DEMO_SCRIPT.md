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
**Target length:** ~4–5 minutes.
**Cast (three personas):** **Entrepreneur** (UMKM owner), **Investor**, **Admin**
(platform reviewer).

---

## 0. Read this first — what is real vs. narrated

Keep the demo honest; judges will check. On testnet (verified 2026-07-02):

- ✅ **Verified on-chain:** a non-whitelisted `invest()` **reverts**; a whitelisted
  `invest()` receives shares via gated `mint`; a **forged Merkle proof on `claim()`
  is rejected**. Invest and dividend deposit/claim are the exercised on-chain paths.
- ⚠️ **Milestone release** is implemented + unit-tested, but the deployed Campaign
  WASM predates the milestone constructor (redeploy pending). → Show the **voting UX**
  (real, off-chain) and *narrate* the on-chain gate; **do not** claim a live release
  on camera.
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
- [ ] Onboard → approve KYC → proposal → approve/deploy → invest → deposit profit →
      claim, end to end. Save the contract addresses + tx hashes for the explorer cutaways.

---

## 2. Storyboard (scene by scene)

Each row: what's on screen → what you click → what to say → the endpoint + on-chain
effect behind it (for a lower-third caption or B-roll).

### Scene 0 — Cold open · the problem (~0:00–0:25)
- **On screen:** Title card "Creon — *urun dana* for UMKM, on Stellar." One-line problem.
- **Action:** Hold on the title; cut to a live campaign card.
- **Narration:** *"63 million Indonesian small businesses—UMKM—struggle to raise
  capital. Retail investors want to help, but face two massive trust gaps: 'Will the
  money be used as promised?' and 'Will I actually get my fair share of the profit?'.
  Creon solves both using Stellar smart contracts."*
- **Behind the scenes:** —

### Scene 1 — Onboarding: wallet + KYC (~0:25–1:05)
- **On screen:** Connect Stellar wallet → KYC form (name, 16-digit **NIK**, ID card +
  selfie upload).
- **Action:** Connect wallet (no password); fill KYC; submit. Show status = PENDING.
- **Narration:** *"Let's see it in action. Users sign in instantly with their Stellar
  wallet—no passwords. We enforce a strict KYC process tied to the unique Indonesian
  National ID (NIK), preventing fake accounts."*
- **Behind the scenes:**
  `POST /auth/challenge` → sign → `POST /auth/register` → `POST /kyc` (idCard + selfie,
  private bucket). Duplicate NIK → `409 Conflict`.

### Scene 2 — Admin approves KYC → on-chain whitelist (~1:05–1:35)
- **On screen:** Admin review queue → the investor's submission → **Approve**.
- **Action:** Approve. Cut to Stellar Expert on the **ComplianceRegistry** contract.
- **Narration:** *"Once an admin approves, the user's wallet is automatically added to
  an on-chain compliance registry. Now, the Soroban contracts natively know who is
  legally allowed to invest."*
- **Behind the scenes:**
  `GET /admin/kyc` → `POST /admin/kyc/:userId/approve` → BullMQ orchestrator calls
  `registry.add(wallet)`.
  **Cutaway:** `stellar.expert/explorer/testnet/contract/CDDYCTY4BP7RMNDT5SQQMOHS6FZ5MKVPB4LIVON6MONBD2L6GWCJZ2YF`
  → show the `add` invocation.

### Scene 3 — Proposal → approval deploys the contracts (~1:35–2:20)
- **On screen:** Entrepreneur creates a proposal — business name, goal (e.g. 10,000
  USDC), lock period, and a **milestone breakdown that must sum to the goal** → Submit.
  Switch to Admin → **Approve**. Campaign status walks `PENDING → … → LIVE`.
- **Action:** Submit proposal; approve as admin; show the campaign go LIVE.
- **Narration:** *"Next, an entrepreneur submits a funding proposal with specific
  milestones. Once approved, our backend acts as a deploy trigger: automatically
  deploying a dedicated Campaign contract and a restricted Share Token on Soroban. No
  manual setup required."*
- **Behind the scenes:**
  `POST /proposals` → `POST /proposals/:id/submit`; `POST /admin/proposals/:id/approve`
  → `campaign-deploy` orchestrator: deploy ShareToken → deploy Campaign →
  `token.set_minter(campaign)` → LIVE.
  **Cutaway:** open the freshly deployed Campaign contract on Stellar Expert (deployed
  from Campaign WASM `462eb8f0…`, ShareToken WASM `ae06cdbb…`).

### Scene 4 — Investor funds the campaign (~2:20–3:05)
- **On screen:** Investor browses **live campaigns** → opens one → enters an amount →
  **Invest**. Wallet prompts to sign. Confirmation shows shares received 1:1.
- **Action:** Invest USDC; sign; show holdings + the campaign's raised amount tick up.
  *(Highlight or zoom in on the wallet transaction showing fee is paid by platform).*
- **Narration:** *"Whitelisted investors fund the campaign directly in USDC. In return,
  they receive a 1-to-1 restricted Share Token. Notice the UX here: the investor signs
  the transaction, but the platform pays the network fee using Stellar's fee-bump. The
  user doesn't need to hold a single drop of XLM."*
- **Behind the scenes:** (relay = prepare → sign → submit)
  `GET /campaigns` → `POST /campaigns/:id/investments/prepare {amount}` → sign →
  `POST /campaigns/:id/investments {signedXdr}` (fee-bumped) → `invest()` pulls USDC +
  mints shares.
  **Cutaway:** the `invest()` tx on Stellar Expert — USDC into custody, `mint` event.

### Scene 5 — Milestone voting *(optional, ~3:05–3:30)*
- **On screen:** Entrepreneur uploads milestone proof; investors see a vote weighted by
  their share balance → **Approve / Reject**.
- **Action:** Submit proof; cast a weighted vote; show the tally.
- **Narration:** *"To protect investors, capital isn't released all at once. It’s
  unlocked in milestone chunks. Each release requires an on-chain, share-weighted
  investor vote. This ensures investors retain control of their funds if the business
  fails to deliver."*
- **Behind the scenes:** `POST /milestones/:id/submit` (proof), `POST /milestones/:id/vote`.
  On-chain `release_milestone` is owner-gated + sequential. *(Do not show a live
  release — WASM redeploy pending. Narrate the gate only.)*

### Scene 6 — Dividends: deposit + Merkle root (*bagi hasil*) (~3:30–4:05)
- **On screen:** Entrepreneur deposits profit into the campaign; the distribution shows
  a posted Merkle root / status COMPLETED.
- **Action:** Deposit profit; wait for the distribution to complete. Cut to a terminal.
  *(Highlight the root hash in the terminal, then highlight the same hash on Stellar Expert).*
- **Narration:** *"When the business generates a profit, they deposit USDC back for
  'bagi hasil', or profit sharing. This is real revenue, not a speculative token. Here’s
  the technical magic: to save on-chain costs, our backend computes everyone's exact cut,
  builds a Merkle tree, and posts only the root to the contract."*
- **Behind the scenes:**
  `POST /campaigns/:id/distributions/deposit/prepare` → sign →
  `.../distributions/deposit` → orchestrator snapshots `TokenHolding` → Merkle tree →
  `set_distribution(id, root)`.
  **Cutaway (trust proof):** run
  `cargo test -p campaign print_merkle_test_vector -- --nocapture` in `contracts/` to
  show the Rust-emitted leaves + root — the same encoding the backend must match
  byte-for-byte.

### Scene 7 — Investor claims their dividend (~4:05–4:35)
- **On screen:** Investor sees a claimable amount → **Claim**. Signs. USDC arrives.
- **Action:** Claim; sign; show USDC balance increase. Cut to the `claim()` tx.
- **Narration:** *"When claiming, the Soroban contract verifies the Merkle proof against
  that root and pays out the exact USDC share. The backend does the heavy computation,
  but cryptographically, it cannot forge who gets paid. Trust is minimized by design."*
- **Behind the scenes:**
  `GET /distributions/mine` (proof) → `POST /distributions/:id/claim/prepare` → sign →
  `.../claim` → on-chain `claim()` verifies proof, pays USDC, marks claimed.
  **Cutaway:** the `claim()` tx on Stellar Expert.

### Scene 8 — Close (~4:35–5:00)
- **On screen:** Recap slate — three icons: **KYC'd security token · Milestone-gated
  release · Merkle dividends**.
- **Narration:** *"Creon: Bringing transparent, compliant crowdfunding to Indonesia.
  KYC-enforced security tokens, milestone-gated funding, and mathematically proven
  dividends. Built on Stellar. Terima kasih."*
- **Behind the scenes:** —

---

## 3. Full narration (voiceover, read straight through)

> 63 million Indonesian small businesses—UMKM—struggle to raise capital. Retail investors
> want to help, but face two massive trust gaps: 'Will the money be used as promised?'
> and 'Will I actually get my fair share of the profit?'. Creon solves both using
> Stellar smart contracts.
>
> Let's see it in action. Users sign in instantly with their Stellar wallet—no passwords.
> We enforce a strict KYC process tied to the unique Indonesian National ID (NIK),
> preventing fake accounts.
>
> Once an admin approves, the user's wallet is automatically added to an on-chain
> compliance registry. Now, the Soroban contracts natively know who is legally allowed
> to invest.
>
> Next, an entrepreneur submits a funding proposal with specific milestones. Once approved,
> our backend acts as a deploy trigger: automatically deploying a dedicated Campaign
> contract and a restricted Share Token on Soroban. No manual setup required.
>
> Whitelisted investors fund the campaign directly in USDC. In return, they receive a
> 1-to-1 restricted Share Token. Notice the UX here: the investor signs the transaction,
> but the platform pays the network fee using Stellar's fee-bump. The user doesn't need
> to hold a single drop of XLM.
>
> To protect investors, capital isn't released all at once. It’s unlocked in milestone
> chunks. Each release requires an on-chain, share-weighted investor vote. This ensures
> investors retain control of their funds if the business fails to deliver.
>
> When the business generates a profit, they deposit USDC back for 'bagi hasil', or
> profit sharing. This is real revenue, not a speculative token. Here’s the technical
> magic: to save on-chain costs, our backend computes everyone's exact cut, builds a
> Merkle tree, and posts only the root to the contract.
>
> When claiming, the Soroban contract verifies the Merkle proof against that root and
> pays out the exact USDC share. The backend does the heavy computation, but
> cryptographically, it cannot forge who gets paid. Trust is minimized by design.
>
> Creon: Bringing transparent, compliant crowdfunding to Indonesia. KYC-enforced
> security tokens, milestone-gated funding, and mathematically proven dividends.
> Built on Stellar. Terima kasih.

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
| **Campaign** WASM hash | `462eb8f08bbd4f19b1c67e7b278aadf507b2a661455cb81a368a954e794a51aa` |
| **USDC** (test SAC) | `CA6NVKD2EVIK73B4YH6JO4XKA2GLGTN222VTOGXAZVNT5QHKLAT3O7N3` |

Per-campaign ShareToken + Campaign instances are deployed from those WASM hashes at
approval time — capture *their* addresses during the dry-run.

**Merkle trust-vector command** (run from `contracts/`):
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

---

## 5. Recording tips

- **Add English Subtitles (Closed Captions):** Since you are keeping local terms like UMKM, *urun dana*, and *bagi hasil* for authenticity, clear English subtitles on the video are crucial for international judges.
- **Zoom** on JSON responses and explorer pages — judges want to see the real ledger.
- **Highlight the Fee-Bump:** When mentioning the platform pays the fee in Scene 4, explicitly zoom in or add a visual highlight box around the fee section in the wallet UI.
- Keep a **lower-third caption** with the endpoint name for each UI action.
- Show the Indonesian terms as on-screen text: *urun dana*, *bagi hasil*, UMKM, NIK.
- Pre-open all explorer tabs to the exact tx/contract pages so there's no loading dead
  air.
- For Scene 5, phrase milestone release in future/implemented tense — don't imply a
  live on-chain release.
- End on the recap slate held long enough to read.

## 6. Pre-flight checklist (tick before the take)

- [ ] Backend up, frontend connected, all dry-run hashes saved
- [ ] Explorer tabs pre-loaded (registry `add`, deploy, `invest`, `claim`)
- [ ] Investor funded with testnet USDC; platform key funded
- [ ] Merkle test-vector command tested in a terminal
- [ ] Mic + screen capture levels checked; captions ready
