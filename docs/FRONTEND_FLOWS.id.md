# Alur Integrasi Frontend

Apa yang perlu diimplementasikan frontend untuk terintegrasi dengan
`creon-backend`, ditulis dari sudut pandang *apa yang dilakukan user* dan *apa
yang ditandatangani wallet* — bukan arsitektur internal service (lihat
`ARCHITECTURE.md`). Bentuk request/response lengkap ada di `openapi.yaml`;
dokumen ini fokus pada "kenapa dan urutannya bagaimana". Versi bahasa Inggris
ada di `FRONTEND_FLOWS.md`.

## Konsep inti (baca dulu)

**Wallet-auth, bukan password.** Identitas = keypair Stellar. Frontend butuh
integrasi wallet (Freighter, xBull, atau signer apa pun) yang bisa:
1. Mengembalikan public key (`G...`, 56 karakter).
2. Menandatangani pesan UTF-8 mentah → signature base64 (untuk auth).
3. Menandatangani XDR envelope base64 → XDR base64 tertandatangani (untuk aksi on-chain).

**JWT.** Setiap panggilan terautentikasi butuh `Authorization: Bearer <token>`.
Dibuat saat register/login, berisi `{ sub: userId, roles: Role[] }`, berlaku
**7 hari** (`JWT_EXPIRES_IN`). Tidak ada endpoint refresh — kalau kedaluwarsa,
ulangi alur login.

**Pola relay (prepare → sign → submit).** Aksi apa pun yang menyentuh USDC/share
milik user sendiri (`invest`, `deposit_profit`, `claim`) butuh tanda tangan
*mereka* — contract mengecek `require_auth()`. Platform tidak bisa menandatangani
atas nama mereka, jadi aksi ini selalu tiga langkah:
1. `POST .../prepare` → backend mengembalikan `{ xdr }` (belum ditandatangani,
   source = wallet user).
2. Wallet menandatangani XDR itu **persis** (jangan diubah) → XDR tertandatangani.
3. `POST .../submit` dengan `{ signedXdr }` → backend memverifikasi call yang
   didekode cocok dengan yang diharapkan (contract, function, args, caller),
   **fee-bump dengan akun platform**, submit ke network, lalu mencatat hasilnya.

Konsekuensi: **user tidak pernah membayar network fee** dan tidak butuh XLM —
hanya USDC (plus wallet yang bisa menandatangani tx invoke Soroban). Endpoint
submit **idempotent**: mengirim ulang XDR yang sama mengembalikan record
tercatat, bukan submit ganda.

**Role.** Satu user bisa punya `ENTREPRENEUR`, `INVESTOR`, atau keduanya. `ADMIN`
hanya lewat seed, tidak pernah muncul di registrasi. **KYC per-user, bukan
per-role** — satu submission berlaku untuk kedua role.

**Dua gerbang approval independen.** Approval KYC (identitas) dan approval
campaign (review proposal) adalah dua aksi admin terpisah dengan status terpisah
— jangan dicampur di UI.

---

## Alur 1 — Register / Login (auth via signature wallet)

Mekanisme challenge-response yang sama untuk keduanya; hanya endpoint terakhir
yang berbeda.

**Langkah**
1. Minta challenge untuk address wallet.
2. Wallet menandatangani `message` yang dikembalikan **sebagai raw bytes**
   (signature pesan, *bukan* transaksi) → `signatureB64`.
3. Panggil **register** (user baru) atau **login** (user lama) dengan signature → `accessToken`.
4. Simpan token; sertakan `Authorization: Bearer <token>` di setiap panggilan berikutnya.

**Endpoint**

| Langkah | Method + Path | Body → hasil |
|---|---|---|
| 1 | `POST /auth/challenge` | `{ walletAddress }` → `{ message }` (string multi-baris format tetap) |
| 3a | `POST /auth/register` | `{ walletAddress, signature, role, email?, displayName? }` → `{ accessToken }` |
| 3b | `POST /auth/login` | `{ walletAddress, signature }` → `{ accessToken }` |

**Catatan penting**
- **Challenge sekali pakai, kedaluwarsa 5 menit** (`AUTH_CHALLENGE_TTL_SECONDS`)
  — tandatangani segera; minta challenge baru jika register/login gagal 401.
- **`role` hanya `ENTREPRENEUR` atau `INVESTOR`** (pilih sesuai alur onboarding).
  `email` **wajib jika role ENTREPRENEUR**, opsional untuk yang lain.
- **Satu wallet hanya bisa register sekali** — belum ada endpoint "add role";
  perlakukan tiap wallet sebagai single-role di UI.
- **`login` tidak dibatasi role** — wallet terdaftar mana pun (termasuk admin
  via DB) bisa login.

---

## Alur 2 — Submission & approval KYC

Submission off-chain, identik untuk entrepreneur maupun investor (dibatasi per
role lewat `@Roles`).

**Langkah**
1. Submit field identitas + foto KTP dan selfie (multipart).
2. Poll status sampai admin memutuskan (tidak ada push/webhook).

**Endpoint**

| Langkah | Method + Path | Body → hasil |
|---|---|---|
| 1 | `POST /kyc` (multipart) | fields: `fullName`, `nationalId` (NIK 16 digit), `dateOfBirth?` (YYYY-MM-DD); files: `idCard`, `selfie` (jpeg/png, ≤5MB) → `{ status: "PENDING", submittedAt }` |
| 2 | `GET /kyc/me` | → `{ status: "PENDING" \| "APPROVED" \| "REJECTED" \| "REVOKED", ... }` |

**Catatan penting**
- **`nationalId` unik secara global → 409 Conflict** jika dipakai akun lain.
  Tampilkan sebagai "NIK ini sudah digunakan untuk verifikasi akun lain."
- **Kirim ulang saat PENDING/REJECTED** menimpa profil (upsert) dan mereset ke PENDING.
- **Poll `GET /kyc/me`** (~tiap 10–30 detik selama PENDING) atau minta user cek kembali.
- **Gerbang selanjutnya mengembalikan 403 sampai APPROVED**
  (`ApprovedEntrepreneurGuard` / `ApprovedInvestorGuard` pada endpoint tulis
  proposal dan invest/claim). Tampilkan state "verifikasi identitas dulu",
  jangan biarkan user menerima 403 mentah.
- **`REVOKED`** (admin mencabut KYC yang sudah approved) memblokir semua gerbang
  seperti REJECTED — perlakukan sama, tapi copy sebaiknya beda ("verifikasi
  dicabut" vs "pengajuan ditolak").

**Sisi admin** (hanya jika membangun UI admin): `GET /admin/kyc?status=PENDING`,
`POST /admin/kyc/:userId/approve`, `.../reject { reason }`, `.../revoke { reason }`.
Approve/revoke memicu sinkronisasi whitelist on-chain secara async — status KYC
langsung berubah, tapi *kemampuan investor benar-benar invest* juga bergantung
pada whitelist yang sudah tercatat di chain (lihat catatan di Alur 4).

---

## Alur 3 — Entrepreneur: mengajukan proposal pendanaan

Sepenuhnya off-chain — tidak ada contract yang disentuh. Semua endpoint tulis
butuh `ApprovedEntrepreneurGuard` (role + KYC APPROVED), jadi bangun alur KYC
dulu dan gerbang tombol "Proposal Baru" berdasarkan `GET /kyc/me`.

**Langkah**
1. Buat proposal (mulai sebagai `DRAFT`).
2. Edit selama `DRAFT` (opsional).
3. Submit → `DRAFT → SUBMITTED` (mengunci edit).
4. Poll keputusan admin.

**Endpoint**

| Langkah | Method + Path | Catatan |
|---|---|---|
| 1 | `POST /proposals` | `{ businessName, businessDescription, category, location?, requestedAmount, lockPeriodDays }` → proposal (`DRAFT`) |
| 2 | `PATCH /proposals/:id` | subset field mana pun; **hanya selama `DRAFT`** |
| 3 | `POST /proposals/:id/submit` | `DRAFT → SUBMITTED` |
| 4 | `GET /proposals` / `GET /proposals/:id` | hanya milik caller (404 jika bukan miliknya) |

**Catatan penting**
- **`requestedAmount` adalah string** (`"1500.5000000"`, sampai 7 desimal) —
  jangan pernah kirim `number` JS untuk field uang di API mana pun.
- **`lockPeriodDays` integer 1–3650** → menjadi durasi lock modal on-chain
  setelah deploy; jelaskan maknanya ("modal pokok investor terkunci sekian hari
  setelah campaign aktif").
- **SUBMITTED read-only** bagi entrepreneur — poll `GET /proposals/:id` dan amati
  `status` berubah ke `UNDER_REVIEW` → `APPROVED` / `REJECTED`.

---

## Alur 4 — Auto-deploy campaign (digerakkan sistem, tanpa aksi user)

Saat admin menyetujui proposal (`POST /admin/proposals/:id/approve`), backend
secara sinkron membuat row `Campaign` lalu **secara asinkron** men-deploy
contract (`ShareToken` + `Campaign`, wiring `set_minter`, lalu mengubah campaign
menjadi live). Butuh beberapa detik sampai beberapa menit; tidak ada yang perlu
dipicu frontend.

**Langkah**
1. Setelah proposal APPROVED, poll `GET /campaigns/:id` (publik, tanpa auth).
2. Amati `deployStatus`: `PENDING → DEPLOYING_TOKEN → DEPLOYING_CAMPAIGN → WIRING → LIVE`
   (atau `FAILED`).
3. Aktifkan "Invest" hanya saat `deployStatus === "LIVE"` **dan** `status === "ACTIVE"`.

**Endpoint**

| Method + Path | Catatan |
|---|---|
| `GET /campaigns` | publik; hanya mengembalikan campaign **LIVE** |
| `GET /campaigns/:id` | publik; poll `deployStatus` / `status` di sini |

**Catatan penting**
- **Gerbang "Invest" pada `deployStatus === "LIVE"` dan `status === "ACTIVE"`** —
  bukan hanya keberadaan `contractAddress`. Endpoint invest-prepare akan 409 jika tidak.
- **Urutan whitelist investor (penting):** wallet investor harus sudah ditambahkan
  ke compliance registry on-chain sebelum `invest()` bisa sukses. Ini terjadi
  otomatis setelah KYC approved lewat orchestrator async terpisah, dilacak sebagai
  `KycProfile.whitelistStatus` (`NOT_SYNCED → ADDING → WHITELISTED`) — **belum
  tersedia di `GET /kyc/me` saat ini**. Jadi jika percobaan `invest` pertama gagal
  tepat setelah KYC approved, kemungkinan besar sinkronisasi whitelist belum
  selesai — tampilkan pesan retry/backoff, bukan error keras (contract menolak
  `invest()` dari wallet belum whitelisted).

---

## Alur 5 — Investor: berinvestasi di campaign

Pola relay (lihat Konsep inti). Butuh `INVESTOR` + KYC approved
(`ApprovedInvestorGuard`) dan campaign LIVE/ACTIVE.

**Langkah**
1. `prepare` dengan amount → `{ campaignId, xdr }`.
2. Wallet menandatangani XDR.
3. `submit` XDR tertandatangani → `Investment` terkonfirmasi (sinkron, tanpa polling).
4. Baca holdings/riwayat sesuai kebutuhan.

**Endpoint**

| Langkah | Method + Path | Body → hasil |
|---|---|---|
| 1 | `POST /campaigns/:campaignId/investments/prepare` | `{ amount }` → `{ campaignId, xdr }` |
| 3 | `POST /campaigns/:campaignId/investments` | `{ signedXdr }` → `Investment { id, campaignId, amount, lpTokens, txHash, status, investedAt }` |
| 4 | `GET /investments/mine` | riwayat pembelian milik caller |
| 4 | `GET /holdings/mine` | saldo turunan on-chain yang **live** |

**Catatan penting**
- **`amount` USDC, string, sampai 7 desimal, > 0.**
- **Share (`lpTokens`) di-mint 1:1 dengan USDC** saat dikonfirmasi.
- **Wallet perlu trustline USDC + saldo sebelum `prepare`** — backend tidak
  mengecek di awal; contract yang menolak tx saat submit. Tampilkan dengan jelas.
- **Share tidak bisa ditransfer selama lock** (SEP-41 dibatasi) — jangan bangun
  UI jual/transfer share apa pun.
- **`status` menjadi `CONFIRMED` begitu submit sukses** (submit sinkron — tidak
  perlu polling di sini, berbeda dengan deploy).
- **Untuk portfolio/kepemilikan, lebih baik `GET /holdings/mine`** daripada
  menjumlahkan `/investments/mine` — yang terakhir adalah catatan historis
  pembelian, bukan kepemilikan saat ini.

---

## Alur 6 — Entrepreneur: membagikan dividen (deposit profit)

Pola relay. Butuh `ENTREPRENEUR` + KYC approved, dan caller harus pemilik
campaign (guard mengecek `proposal.entrepreneurId`).

**Langkah**
1. `prepare` dengan amount profit → `{ campaignId, xdr }`.
2. Wallet menandatangani XDR.
3. `submit` → langsung mengembalikan `status: "PENDING"`.
4. Poll distribusi sampai `status === "COMPLETED"` (job latar membangun snapshot
   Merkle + memanggil `set_distribution` on-chain) **sebelum** memberi tahu
   investor bahwa dividen bisa diklaim.

**Endpoint**

| Langkah | Method + Path | Body → hasil |
|---|---|---|
| 1 | `POST /campaigns/:campaignId/distributions/deposit/prepare` | `{ amount }` → `{ campaignId, xdr }` |
| 3 | `POST /campaigns/:campaignId/distributions/deposit` | `{ signedXdr }` → `ProfitDistribution { id, onchainId, totalAmount, status: "PENDING", ... }` |
| 4 | `GET /campaigns/:campaignId/distributions` | semua distribusi campaign (publik) |

**Catatan penting**
- **`amount` profit USDC, string, > 0**; wallet perlu punya USDC untuk dideposit
  (catatan trustline/saldo sama seperti invest).
- **Submit mengembalikan PENDING; kerja on-chain berjalan async.** Poll sampai
  `COMPLETED` — distribusi yang masih PENDING belum punya klaim untuk diambil.
- **`totalShares` / `rewardPerShare` / `merkleRoot` terisi setelah job selesai** —
  perlakukan sebagai kosong/loading selama PENDING.
- **Entitlement di-snapshot dari pemegang share saat deposit dikonfirmasi**
  (pro-rata pembulatan ke bawah) — tidak ada tanggal "berlaku sejak" yang perlu
  dikelola; otomatis.

---

## Alur 7 — Investor: mengklaim dividen

Pola relay. Butuh `INVESTOR` + KYC approved.

**Langkah**
1. List entitlement untuk menemukan row yang bisa diklaim.
2. `prepare` klaim untuk sebuah distribusi → `{ distributionId, xdr }`.
3. Wallet menandatangani XDR.
4. `submit` → `status: "CLAIMED"`; USDC langsung masuk ke wallet on-chain.

**Endpoint**

| Langkah | Method + Path | Body → hasil |
|---|---|---|
| 1 | `GET /distributions/mine` | `DistributionClaim[] { id, distributionId, amount, status, distribution: { onchainId, campaignId, status } }` |
| 2 | `POST /distributions/:distributionId/claim/prepare` | (tanpa body) → `{ distributionId, xdr }` |
| 4 | `POST /distributions/:distributionId/claim` | `{ signedXdr }` → `DistributionClaim { ..., status: "CLAIMED", claimTxHash, claimedAt }` |

**Catatan penting**
- **Tampilkan "Claim" hanya saat klaim `status === "PENDING"` DAN
  `distribution.status === "COMPLETED"` di dalamnya** — `prepare` akan 409 jika
  Merkle root belum diposting (distribusi masih PENDING) atau tidak ada row
  entitlement untuk user (memegang nol share saat snapshot; tidak akan muncul di
  `/distributions/mine`).
- **Klaim tidak dibatasi waktu** — dividen yang belum diklaim tetap bisa diklaim
  kapan saja (tidak ada jalur expiry/reclaim); tidak perlu pesan "kedaluwarsa
  dalam X hari".
- **`amount` adalah entitlement tetap**, dipatok Merkle tree di sisi server —
  investor tidak bisa memilih jumlah parsial.
- **Tidak ada langkah "withdraw" terpisah** — USDC masuk ke wallet begitu klaim sukses.

---

## Contekan field status

Apa yang perlu di-poll dan arti tiap nilai, untuk state loading/empty.

| Entitas | Field | Nilai yang relevan untuk frontend |
|---|---|---|
| KYC | `KycProfile.status` | `PENDING` (tunggu) → `APPROVED` (terbuka) / `REJECTED` / `REVOKED` (terblokir, submit ulang) |
| Proposal | `Proposal.status` | `DRAFT` (bisa diedit) → `SUBMITTED` → `UNDER_REVIEW` → `APPROVED` / `REJECTED` |
| Campaign | `Campaign.deployStatus` | `PENDING`…`WIRING` ("sedang deploy") → `LIVE` (bisa dipakai) / `FAILED` |
| Campaign | `Campaign.status` | `PENDING_DEPLOYMENT` → `ACTIVE` (bisa diinvestasikan) → `LOCKED` / `GOAL_REACHED` / `COMPLETED` / `CANCELLED` |
| Investment | `Investment.status` | `CONFIRMED` (submit sinkron; jarang terlihat `PENDING` / `FAILED`) |
| Distribution | `ProfitDistribution.status` | `PENDING` (Merkle tree sedang dibangun / posting on-chain — klaim belum siap) → `COMPLETED` (bisa diklaim) / `FAILED` |
| Claim | `DistributionClaim.status` | `PENDING` (bisa diklaim, tampilkan tombol) → `CLAIMED` (selesai) |

## Konvensi penanganan error

- **Nest HTTP exception standar** dengan body `{ statusCode, message, error }`:
  `400` (validasi/state salah), `401` (JWT atau signature wallet
  salah/hilang/kedaluwarsa), `403` (gerbang role atau KYC gagal), `404` (tidak
  ditemukan / bukan milik caller), `409` (state konflik — campaign belum bisa
  diinvestasikan, NIK sudah dipakai, klaim sudah diambil).
- **`ValidationPipe` `whitelist`** membuang field body tak dikenal dan mengoersi
  tipe — jangan mengandalkan backend menolak field ekstra, tapi tetap kirim nilai
  bertipe benar (angka sebagai number, uang sebagai string).
- **Kegagalan `/prepare` → sign → `/submit` mana pun aman dicoba ulang dari
  `/prepare`** — tidak ada yang tersimpan sampai submit berhasil.
