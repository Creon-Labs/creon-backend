# Alur Integrasi Frontend

Dokumen ini menjelaskan alur-alur yang perlu diimplementasikan frontend untuk
bisa terintegrasi dengan `creon-backend`. Ditulis dari sudut pandang *apa yang
dilakukan user* dan *apa yang perlu ditandatangani wallet*, bukan dari sisi
arsitektur internal service (lihat `ARCHITECTURE.md` untuk itu). Bentuk
request/response lengkap ada di `openapi.yaml` — dokumen ini fokus pada
"kenapa dan urutannya bagaimana". Versi bahasa Inggris ada di
`FRONTEND_FLOWS.md`.

## Konsep inti sebelum mulai

**Wallet-auth, bukan password.** Tidak ada email/password. Identitas = keypair
Stellar. Frontend butuh integrasi wallet Stellar (Freighter, xBull, atau
signer apa pun yang bisa menandatangani payload bebas / transaksi klasik) yang
bisa:
1. Mengembalikan public key user (`G...`, 56 karakter).
2. Menandatangani pesan UTF-8 mentah dan mengembalikan signature base64
   (untuk auth).
3. Menandatangani transaction envelope XDR base64 dan mengembalikan XDR
   base64 yang sudah ditandatangani (untuk aksi on-chain).

**JWT.** Setiap panggilan yang butuh autentikasi memerlukan header
`Authorization: Bearer <token>`. Token dibuat saat register/login, berisi
`{ sub: userId, roles: Role[] }`, dan berlaku **7 hari** (`JWT_EXPIRES_IN`).
Tidak ada endpoint refresh — kalau token kedaluwarsa, ulangi saja alur login
(challenge → sign → login).

**Pola relay (prepare → sign → submit).** Aksi apa pun yang menyentuh USDC/share
milik investor atau entrepreneur sendiri (`invest`, `deposit_profit`, `claim`)
butuh tanda tangan *mereka* — contract mengecek `require_auth()` pada address
tersebut. Platform tidak bisa menandatangani atas nama mereka. Jadi aksi-aksi
ini selalu dua langkah:
1. `POST .../prepare` → backend membangun transaksi belum ditandatangani dan
   mengembalikan `{ xdr }` (XDR base64, source account = wallet user).
2. Frontend meminta wallet menandatangani XDR tersebut persis (jangan diubah)
   dan mendapatkan XDR yang sudah ditandatangani.
3. `POST .../submit` dengan `{ signedXdr }` → backend memverifikasi call yang
   didekode cocok dengan yang diharapkan (contract, function, args, caller),
   **fee-bump menggunakan akun platform**, submit ke network, lalu mencatat
   hasilnya.

Artinya **user tidak pernah membayar network fee** dan tidak perlu punya XLM
di wallet-nya — mereka hanya butuh USDC (dan wallet yang bisa menandatangani
transaksi invoke Soroban). Endpoint submit bersifat idempotent: mengirim ulang
XDR yang sama akan mengembalikan record yang sudah tercatat, bukan error atau
submit ganda.

**Role.** Satu user bisa punya role `ENTREPRENEUR`, `INVESTOR`, atau
keduanya. `ADMIN` hanya dibuat lewat seed — tidak pernah muncul di
registrasi. KYC bersifat **per-user, bukan per-role**: satu submission KYC
berlaku untuk keduanya jika user terdaftar sebagai keduanya.

**Dua gerbang approval yang independen.** Approval KYC (identitas) dan
approval campaign (review proposal) adalah dua aksi admin yang terpisah
dengan status terpisah — jangan dicampur di UI.

---

## Alur 1 — Register / Login (auth via signature wallet)

Mekanisme challenge-response yang sama untuk keduanya; bedanya hanya endpoint
mana yang dipanggil di langkah terakhir.

```
1. POST /auth/challenge  { walletAddress }
   -> { message }                      // string multi-baris dengan format tetap

2. Wallet menandatangani `message` sebagai raw bytes (BUKAN transaksi — murni
   signature pesan) -> signatureB64

3a. User baru:
    POST /auth/register { walletAddress, signature, role, email?, displayName? }
    -> { accessToken }

3b. User yang sudah ada:
    POST /auth/login { walletAddress, signature }
    -> { accessToken }
```

Catatan:
- Challenge hanya sekali pakai dan kedaluwarsa dalam 5 menit
  (`AUTH_CHALLENGE_TTL_SECONDS`) — tandatangani dan kirim segera, dan minta
  challenge baru jika register/login gagal dengan 401.
- `role` saat register hanya `ENTREPRENEUR` atau `INVESTOR` (pilih sesuai alur
  onboarding yang dijalankan user). `email` **wajib jika role ENTREPRENEUR**,
  opsional untuk yang lain. Satu wallet hanya bisa register sekali; untuk
  menambahkan role lain pada orang yang sama saat ini belum ada endpoint
  "add role" — perlakukan tiap wallet sebagai single-role di UI.
- `login` tidak dibatasi role — wallet manapun yang sudah terdaftar (termasuk
  admin yang dibuat via DB) bisa login dengannya.
- Simpan `accessToken` (misalnya di memory + secure storage); sertakan sebagai
  `Authorization: Bearer <token>` di setiap panggilan berikutnya.

---

## Alur 2 — Submission & approval KYC

Berlaku identik untuk entrepreneur maupun investor — endpoint sama, dibatasi
per role lewat `@Roles`.

```
POST /kyc   (multipart/form-data, butuh auth)
  fields: fullName, nationalId (NIK 16 digit), dateOfBirth? (YYYY-MM-DD)
  files:  idCard (jpeg/png, ≤5MB), selfie (jpeg/png, ≤5MB)
-> { status: "PENDING", submittedAt }

GET /kyc/me   (butuh auth)
-> { status: "PENDING" | "APPROVED" | "REJECTED" | "REVOKED", ... }
```

- `nationalId` bersifat unik secara global — submission kedua dengan NIK yang
  sudah dipakai akun lain akan mendapat **409 Conflict**. Tampilkan sebagai
  "NIK ini sudah digunakan untuk verifikasi akun lain."
- Mengirim ulang saat status PENDING/REJECTED akan menimpa profil (upsert)
  dan mereset status ke PENDING.
- **Poll `GET /kyc/me`** setelah submit untuk memantau keputusan admin — tidak
  ada push/webhook. Interval yang wajar adalah tiap 10–30 detik selama status
  PENDING, atau cukup minta user cek kembali nanti.
- Gerbang selanjutnya: `ApprovedEntrepreneurGuard` / `ApprovedInvestorGuard`
  memblokir endpoint tulis proposal dan investment/claim dengan **403** sampai
  `KycProfile.status === APPROVED`. Tampilkan state "verifikasi identitas dulu"
  yang jelas, jangan biarkan user menerima 403 mentah.
- `REVOKED` (admin bisa mencabut KYC yang sebelumnya sudah approved)
  berperilaku sama seperti belum-approved di semua gerbang — perlakukan sama
  dengan REJECTED di UI, tapi copy-nya sebaiknya beda ("verifikasi Anda
  dicabut" vs "pengajuan Anda ditolak").

Sisi admin (jika membangun UI khusus admin):
`GET /admin/kyc?status=PENDING`, `POST /admin/kyc/:userId/approve`,
`POST /admin/kyc/:userId/reject { reason }`, `POST /admin/kyc/:userId/revoke { reason }`.
Approve/revoke masing-masing memicu sinkronisasi whitelist on-chain secara
async — status KYC langsung berubah, tapi *kemampuan investor untuk benar-benar
invest* juga bergantung pada whitelist yang sudah tercatat di chain (lihat
catatan penting di Alur 4).

---

## Alur 3 — Entrepreneur: mengajukan proposal pendanaan

Sepenuhnya off-chain — tidak ada contract yang disentuh di sini.

```
POST   /proposals               { businessName, businessDescription, category,
                                   location?, requestedAmount, lockPeriodDays }
       -> proposal (status: DRAFT)

PATCH  /proposals/:id           (subset field manapun di atas)
       -> hanya boleh selama status === DRAFT

POST   /proposals/:id/submit    -> DRAFT -> SUBMITTED (mengunci edit)

GET    /proposals                -> proposal milik caller sendiri
GET    /proposals/:id             -> satu proposal milik caller (404 jika bukan miliknya)
```

- Semua endpoint tulis butuh `ApprovedEntrepreneurGuard` (role + KYC APPROVED)
  — bangun alur KYC dulu, gerbang tombol "Proposal Baru" berdasarkan status
  `GET /kyc/me`.
- `requestedAmount` adalah **string** (format `"1500.5000000"`, sampai 7
  desimal) — jangan pernah kirim `number` JS untuk field uang di API manapun.
- `lockPeriodDays` adalah integer 1–3650; ini akan menjadi durasi lock
  on-chain begitu campaign live, jelaskan maknanya di form ("modal pokok
  investor terkunci selama sekian hari setelah campaign aktif").
- Setelah SUBMITTED, proposal read-only bagi entrepreneur; tunggu keputusan
  admin. Tidak ada push untuk detail proposal — poll `GET /proposals/:id` dan
  amati `status` berubah menjadi `APPROVED`/`REJECTED`, atau `UNDER_REVIEW` di
  antaranya.

---

## Alur 4 — Auto-deploy campaign (digerakkan sistem, tanpa aksi user)

Saat admin menyetujui proposal (`POST /admin/proposals/:id/approve`), backend
secara sinkron membuat row `Campaign` lalu **secara asinkron** men-deploy
contract on-chain (`ShareToken` + `Campaign`, wiring `set_minter`, lalu
mengubah campaign menjadi live). Ini bisa memakan waktu dari beberapa detik
sampai beberapa menit dan sepenuhnya digerakkan backend — tidak ada yang perlu
dipicu frontend.

Yang perlu dilakukan frontend:
- Setelah proposal APPROVED, poll `GET /campaigns/:id` (publik, tanpa auth)
  dan amati `deployStatus` berjalan:
  `PENDING → DEPLOYING_TOKEN → DEPLOYING_CAMPAIGN → WIRING → LIVE` (atau `FAILED`).
- Campaign baru bisa diinvestasikan setelah `deployStatus === "LIVE"` **dan**
  `status === "ACTIVE"`; endpoint invest-prepare akan mengembalikan 409 jika
  tidak. Gerbang tombol "Invest" pada kedua field ini, bukan hanya keberadaan
  `contractAddress`.
- Endpoint browsing bersifat publik dan tanpa auth: `GET /campaigns` (hanya
  mengembalikan yang LIVE) dan `GET /campaigns/:id`.

**Catatan penting soal urutan whitelist investor:** wallet investor harus
sudah ditambahkan ke compliance registry on-chain sebelum tx `invest()`
mereka bisa sukses — ini terjadi otomatis setelah KYC approved lewat
orchestrator async serupa, dilacak sebagai `KycProfile.whitelistStatus`
(`NOT_SYNCED → ADDING → WHITELISTED`). Field ini belum langsung tersedia di
`GET /kyc/me` saat ini, jadi dalam praktiknya: **jika percobaan `invest`
pertama investor gagal tepat setelah KYC mereka baru saja di-approve, sangat
mungkin sinkronisasi whitelist belum selesai — tampilkan pesan retry/backoff,
bukan error keras**, karena contract sendiri akan menolak call `invest()` dari
wallet yang belum whitelisted.

---

## Alur 5 — Investor: berinvestasi di campaign

Pola relay (lihat Konsep Inti). Butuh role `INVESTOR` + KYC approved
(`ApprovedInvestorGuard`) dan campaign harus LIVE/ACTIVE.

```
POST /campaigns/:campaignId/investments/prepare   { amount }
  -> { campaignId, xdr }

[wallet menandatangani xdr]

POST /campaigns/:campaignId/investments           { signedXdr }
  -> Investment { id, campaignId, amount, lpTokens, txHash, status, investedAt }

GET  /investments/mine   -> riwayat investasi milik caller sendiri
```

- `amount` adalah USDC, string, sampai 7 desimal, harus > 0.
- Share (`lpTokens`) di-mint **1:1** dengan USDC yang diinvestasikan saat
  dikonfirmasi.
- Wallet investor perlu punya trustline USDC dan saldo USDC yang cukup
  *sebelum* prepare — jika call invest gagal saat submit karena saldo/
  trustline kurang, tampilkan pesan itu dengan jelas (backend tidak
  mengecek saldo di awal, contract yang akan menolak tx-nya).
- Share **tidak bisa ditransfer selama periode lock** (SEP-41 dibatasi) —
  jangan bangun UI "jual/transfer share" apa pun; belum ada fiturnya.
- `status` pada Investment yang dikembalikan adalah `CONFIRMED` begitu submit
  sukses (submit bersifat sinkron end-to-end — tidak perlu polling di sini,
  berbeda dengan proses deploy).
- Untuk menampilkan portfolio/kepemilikan investor saat ini, lebih baik pakai
  `GET /holdings/mine` (saldo turunan on-chain yang live) daripada menjumlahkan
  `/investments/mine` — yang terakhir adalah catatan historis pembelian, bukan
  kepemilikan saat ini, dan tidak akan akurat jika suatu saat platform
  menambahkan jalur transfer.

---

## Alur 6 — Entrepreneur: membagikan dividen (deposit profit)

Pola relay yang sama seperti invest. Butuh role `ENTREPRENEUR` + KYC approved,
dan caller harus pemilik campaign tersebut (guard mengecek
`proposal.entrepreneurId`).

```
POST /campaigns/:campaignId/distributions/deposit/prepare   { amount }
  -> { campaignId, xdr }

[wallet menandatangani xdr]

POST /campaigns/:campaignId/distributions/deposit           { signedXdr }
  -> ProfitDistribution { id, onchainId, totalAmount, status: "PENDING", ... }

GET  /campaigns/:campaignId/distributions   -> semua distribusi campaign (publik)
```

- `amount` adalah profit USDC yang dideposit, string, > 0. Wallet entrepreneur
  perlu punya USDC untuk dideposit (catatan trustline/saldo sama seperti
  invest).
- Call deposit submit mengembalikan hasil **langsung** dengan
  `status: "PENDING"` — proses snapshot Merkle + pemanggilan
  `set_distribution` on-chain yang sebenarnya berjalan **secara asinkron** di
  belakang layar (bisa memakan waktu, mirip campaign deploy). **Poll
  `GET /campaigns/:campaignId/distributions` (atau lacak `id` yang
  dikembalikan) sampai `status` distribusi tersebut menjadi `COMPLETED`**
  sebelum memberi tahu investor bahwa dividen sudah bisa diklaim — distribusi
  yang masih PENDING belum punya klaim untuk diambil.
- `totalShares`/`rewardPerShare`/`merkleRoot` baru terisi setelah job di
  belakang layar selesai; perlakukan sebagai kosong/loading selama PENDING.
- Entitlement dihitung dengan **snapshot pemegang share saat deposit
  dikonfirmasi** (pro-rata pembulatan ke bawah) — tidak ada tanggal "berlaku
  sejak" yang perlu dikelola frontend; ini otomatis.

---

## Alur 7 — Investor: mengklaim dividen

Pola relay lagi. Butuh role `INVESTOR` + KYC approved.

```
GET  /distributions/mine   -> entitlement milik caller di semua campaign
  -> DistributionClaim[] { id, distributionId, amount, status, distribution: { onchainId, campaignId, status } }

POST /distributions/:distributionId/claim/prepare   (tanpa body)
  -> { distributionId, xdr }

[wallet menandatangani xdr]

POST /distributions/:distributionId/claim           { signedXdr }
  -> DistributionClaim { ..., status: "CLAIMED", claimTxHash, claimedAt }
```

- Tampilkan tombol "Claim" hanya saat klaim `status === "PENDING"` **dan**
  `distribution.status === "COMPLETED"` di dalamnya — prepare akan
  mengembalikan 409 jika Merkle root distribusi belum diposting on-chain
  (masih PENDING), atau jika memang tidak ada row entitlement untuk user
  tersebut (mereka memegang nol share saat snapshot — `GET /distributions/mine`
  cukup tidak akan menampilkannya).
- Klaim **tidak dibatasi waktu** — dividen yang belum diklaim tetap bisa
  diklaim kapan saja (contract tidak punya jalur expiry/reclaim), jadi tidak
  perlu pesan "kedaluwarsa dalam X hari".
- `amount` pada klaim adalah entitlement tetap investor dalam USDC — sudah
  dipatok lewat Merkle tree di sisi server, investor tidak bisa memilih
  jumlah parsial.
- Setelah klaim sukses, USDC langsung masuk ke wallet investor on-chain —
  tidak ada langkah "withdraw" terpisah.

---

## Contekan field status

Referensi cepat untuk apa yang perlu di-poll dan arti tiap nilai, untuk
membangun state loading/empty tanpa harus membaca ulang source backend.

| Entitas | Field | Nilai yang relevan untuk frontend |
|---|---|---|
| KYC | `KycProfile.status` | `PENDING` (tunggu) → `APPROVED` (terbuka) / `REJECTED` / `REVOKED` (terblokir, submit ulang) |
| Proposal | `Proposal.status` | `DRAFT` (bisa diedit) → `SUBMITTED` → `UNDER_REVIEW` → `APPROVED` / `REJECTED` |
| Campaign | `Campaign.deployStatus` | `PENDING`…`WIRING` (tampilkan "sedang deploy") → `LIVE` (bisa dipakai) / `FAILED` |
| Campaign | `Campaign.status` | `PENDING_DEPLOYMENT` → `ACTIVE` (bisa diinvestasikan) → `LOCKED`/`GOAL_REACHED`/`COMPLETED`/`CANCELLED` |
| Investment | `Investment.status` | `CONFIRMED` (submit bersifat sinkron; jarang terlihat `PENDING`/`FAILED`) |
| Distribution | `ProfitDistribution.status` | `PENDING` (Merkle tree sedang dibangun / posting on-chain — klaim belum siap) → `COMPLETED` (bisa diklaim) / `FAILED` |
| Claim | `DistributionClaim.status` | `PENDING` (bisa diklaim, tampilkan tombol) → `CLAIMED` (selesai) |

## Konvensi penanganan error

- Semua error berupa Nest HTTP exception standar dengan body JSON
  `{ statusCode, message, error }` — `400` (validasi/state salah), `401`
  (JWT atau signature wallet salah/hilang/kedaluwarsa), `403` (gerbang role
  atau KYC gagal), `404` (tidak ditemukan / bukan milik caller), `409` (state
  konflik, mis. campaign belum bisa diinvestasikan, NIK sudah dipakai, klaim
  sudah diambil).
- `whitelist` (`ValidationPipe`) membuang field body yang tidak dikenal dan
  mengoerensi tipe — jangan mengandalkan backend menolak field ekstra, tapi
  tetap kirim nilai dengan tipe yang benar (angka sebagai number, uang
  sebagai string).
- Untuk alur `/prepare` → sign → `/submit` mana pun, kegagalan saat submit
  (signature salah, contract/function/args salah, saldo kurang) aman untuk
  dicoba ulang dari `/prepare` lagi — tidak ada yang tersimpan sampai submit
  berhasil.
