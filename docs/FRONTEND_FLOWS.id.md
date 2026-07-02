# Frontend Integration Flows

Dokumen ini menjelaskan apa saja yang perlu diimplementasikan oleh frontend agar bisa bekerja dengan `creon-backend`. Panduan ini berfokus pada **apa yang dilakukan oleh user** dan **apa yang ditandatangani oleh Wallet** — bukan membahas arsitektur internal *service* (untuk itu, lihat `ARCHITECTURE.md`). Detail lengkap mengenai bentuk *request*/*response* ada di `openapi.yaml`; dokumen ini berfokus pada "mengapa dan bagaimana urutannya".

## Konsep Utama (baca ini dulu)

**Autentikasi menggunakan Wallet, bukan password.** Identitas = sebuah *keypair* Stellar. Anda butuh integrasi *Wallet* (seperti Freighter, xBull, atau *signer* lainnya) yang bisa:
1. Mengembalikan *public key* (`G...`, 56 karakter).
2. Menandatangani pesan *raw* UTF-8 → *signature* base64 (untuk autentikasi).
3. Menandatangani *tx envelope* XDR base64 → *signed* XDR base64 (untuk aksi *on-chain*).

**JWT.** Setiap pemanggilan API yang butuh autentikasi harus menggunakan `Authorization: Bearer <token>`. Token ini di-*mint* saat *register/login*, berisi `{ sub: userId, roles: Role[] }`, dan akan *expired* dalam **7 hari** (`JWT_EXPIRES_IN`). Tidak ada *endpoint* *refresh* — kalau *expired*, jalankan ulang proses *login*.

**Pola Relay (*prepare* → *sign* → *submit*).** Apapun yang menyentuh saldo USDC/saham (*shares*) milik *user* (`invest`, `deposit_profit`, `claim`) membutuhkan *signature* dari mereka — karena *contract* akan memanggil `require_auth()`. *Platform* tidak bisa menandatanganinya untuk mereka, jadi proses ini selalu terdiri dari tiga langkah:
1. `POST .../prepare` → backend mengembalikan `{ xdr }` (*unsigned*, *source* = *Wallet* milik *user*).
2. *Wallet* menandatangani XDR **sama persis** seperti yang dikembalikan (jangan dimodifikasi) → *signed* XDR.
3. `POST .../submit` dengan `{ signedXdr }` → backend memverifikasi bahwa *request* yang di-*decode* sesuai dengan ekspektasi (*contract*, *function*, *args*, *caller*), melakukan **fee-bumps menggunakan akun platform**, melakukan *submit*, dan menyimpan hasilnya.

Konsekuensi: **user tidak pernah membayar network fees** dan tidak butuh XLM — mereka hanya butuh USDC (serta *Wallet* yang mendukung fitur *sign* untuk Soroban *invoke txs*). *Endpoint* *submit* bersifat **idempotent**: men-*submit* ulang XDR yang sama akan mengembalikan data yang sudah tersimpan alih-alih melakukan *double-submit*.

**Roles.** Seorang *user* bisa memiliki *role* `ENTREPRENEUR`, `INVESTOR`, atau keduanya. `ADMIN` hanya untuk keperluan *seed*, tidak pernah dimunculkan saat registrasi. **KYC berlaku per user, bukan per role** — satu kali *submit* KYC sudah meng-cover kedua *role*.

**Dua gerbang approval yang independen.** *Approval* KYC (verifikasi identitas) dan *approval* *Campaign* (peninjauan *Proposal*) adalah aksi admin yang terpisah dengan status yang berbeda — jangan mencampuradukkan keduanya di UI.

---

## Flow 1 — Register / Login (Autentikasi Wallet Signature)

Keduanya menggunakan alur *challenge-response* yang sama; hanya *endpoint* akhirnya saja yang berbeda.

**Langkah-langkah:**
1. *Request* sebuah *challenge* menggunakan alamat *Wallet*.
2. *Wallet* menandatangani `message` yang dikembalikan **sebagai raw bytes** (ini adalah *message signature*, **bukan** transaksi) → `signatureB64`.
3. Panggil *endpoint* **register** (*user* baru) atau **login** (*user* lama) dengan *signature* tersebut → `accessToken`.
4. Simpan token tersebut; selalu sertakan `Authorization: Bearer <token>` pada setiap *request* API selanjutnya.

**Endpoints:**

| Langkah | Method + Path | Body → Return |
|---|---|---|
| 1 | `POST /auth/challenge` | `{ walletAddress }` → `{ message }` (*string multi-line* dengan format tetap) |
| 3a | `POST /auth/register` | `{ walletAddress, signature, role, email?, displayName? }` → `{ accessToken }` |
| 3b | `POST /auth/login` | `{ walletAddress, signature }` → `{ accessToken }` |

**Catatan Penting:**
- **Challenge hanya berlaku satu kali dan expired dalam 5 menit** (`AUTH_CHALLENGE_TTL_SECONDS`) — segera lakukan *sign*; *request* ulang *challenge* baru jika *register/login* gagal dengan status `401`.
- **`role` hanya boleh diisi `ENTREPRENEUR` atau `INVESTOR`** (pilih berdasarkan alur *onboarding* yang dipilih *user*). `email` **wajib diisi jika role adalah ENTREPRENEUR**, selain itu opsional.
- **Satu registrasi per Wallet** — tidak ada *endpoint* "tambah role"; anggap setiap *Wallet* hanya memiliki satu *role* di UI.
- **`login` tidak dibatasi oleh role** — *Wallet* mana pun yang sudah terdaftar (termasuk *seeded* admin) bisa melakukan *login*.

---

## Flow 2 — Submit & Approval KYC

Proses *submit* dilakukan secara *off-chain*, alurnya sama persis untuk *Entrepreneur* dan *Investor* (dibatasi *role* melalui `@Roles`).

**Langkah-langkah:**
1. *Submit* data identitas + foto KTP dan *selfie* (*multipart*).
2. Lakukan *polling* status sampai admin memberikan keputusan (tidak ada mekanisme *push/webhook*).

**Endpoints:**

| Langkah | Method + Path | Body → Return |
|---|---|---|
| 1 | `POST /kyc` (multipart) | fields: `fullName`, `nationalId` (NIK 16-digit), `dateOfBirth?` (YYYY-MM-DD); files: `idCard`, `selfie` (jpeg/png, ≤5MB) → `{ status: "PENDING", submittedAt }` |
| 2 | `GET /kyc/me` | → `{ status: "PENDING" \| "APPROVED" \| "REJECTED" \| "REVOKED", ... }` |

**Catatan Penting:**
- **`nationalId` bersifat unik secara global → 409 Conflict** jika dipakai ulang oleh akun lain. Tampilkan pesan seperti "NIK ini sudah digunakan untuk memverifikasi akun lain." di frontend.
- **Resubmit saat status PENDING/REJECTED** akan menimpa profil sebelumnya (*upsert*) dan me-reset status kembali menjadi `PENDING`.
- **Lakukan polling `GET /kyc/me`** (sekitar setiap 10–30 detik selama status `PENDING`) atau minta *user* untuk mengecek kembali nanti.
- **Endpoint yang dilindungi akan mengembalikan 403 sampai KYC berstatus APPROVED** (menggunakan `ApprovedEntrepreneurGuard` / `ApprovedInvestorGuard` untuk mengubah *Proposal* serta aksi *invest/claim*). Tampilkan UI "verifikasi identitas Anda terlebih dahulu" alih-alih menampilkan *error* 403 mentah-mentah.
- **`REVOKED`** (admin mencabut KYC yang sebelumnya `APPROVED`) akan memblokir semua akses layaknya `REJECTED` — tangani dengan cara yang sama, namun gunakan teks (*copywriting*) yang berbeda ("verifikasi Anda telah dicabut" vs "pengajuan Anda ditolak").

**Sisi Admin** (hanya jika Anda membangun UI admin): `GET /admin/kyc?status=PENDING`, `POST /admin/kyc/:userId/approve`, `.../reject { reason }`, `.../revoke { reason }`.
Aksi `Approve/revoke` akan memicu sinkronisasi *whitelist* *on-chain* secara asinkron — `status` KYC akan langsung berubah seketika, namun kemampuan *Investor* untuk *invest* juga bergantung pada proses masuknya data *whitelist* ke *on-chain* (lihat catatan di Flow 4).

---

## Flow 3 — Entrepreneur: Submit Funding Proposal

Hanya berjalan *off-chain* — tidak berinteraksi dengan *contract*. Semua *route* yang bersifat mengubah data (write) mewajibkan `ApprovedEntrepreneurGuard` (*role* + KYC `APPROVED`), jadi selesaikan UI KYC terlebih dahulu dan kunci tombol "New Proposal" bergantung pada `GET /kyc/me`.

**Langkah-langkah:**
1. Buat *Proposal* (dimulai dengan status `DRAFT`).
2. Edit selama masih `DRAFT` (opsional).
3. Lakukan *submit* → `DRAFT → SUBMITTED` (mengunci akses edit).
4. *Polling* untuk menunggu keputusan admin.

**Endpoints:**

| Langkah | Method + Path | Catatan |
|---|---|---|
| 1 | `POST /proposals` | `{ businessName, businessDescription, category, location?, requestedAmount, lockPeriodDays }` → kembaliannya berupa data Proposal (`DRAFT`) |
| 2 | `PATCH /proposals/:id` | Boleh mengirim sebagian *field* di atas; **hanya bisa saat status `DRAFT`** |
| 3 | `POST /proposals/:id/submit` | `DRAFT → SUBMITTED` |
| 4 | `GET /proposals` / `GET /proposals/:id` | Hanya bisa mengakses milik pemanggil API (404 jika bukan milik mereka) |

**Catatan Penting:**
- **`requestedAmount` adalah tipe string** (contoh: `"1500.5000000"`, mendukung hingga 7 desimal) — jangan pernah mengirim tipe JS `number` untuk nominal uang di mana pun dalam API ini.
- **`lockPeriodDays` adalah integer 1–3650** → nilai ini akan menjadi durasi *lock* modal *on-chain* setelah proses *deploy*; buat pengertiannya jelas di UI ("modal terkunci selama X hari setelah *Campaign* berjalan").
- **Status SUBMITTED bersifat read-only** bagi *Entrepreneur* — lakukan *polling* `GET /proposals/:id` dan pantau perpindahan `status` ke `UNDER_REVIEW` → `APPROVED` / `REJECTED`.

---

## Flow 4 — Auto-deploy Campaign (Sistem, tanpa aksi user)

Ketika admin menyetujui sebuah *Proposal* (`POST /admin/proposals/:id/approve`), backend secara sinkron akan membuat data *row* `Campaign` dan **secara asinkron** melakukan *deploy* *contracts* (`ShareToken` + `Campaign`, melakukan `set_minter`, dan mengaktifkannya). Proses ini memakan waktu beberapa detik hingga beberapa menit; tidak ada *trigger* apa pun yang perlu dipanggil oleh frontend.

**Langkah-langkah:**
1. Setelah *Proposal* `APPROVED`, *polling* `GET /campaigns/:id` (*public*, tanpa *auth*).
2. Pantau `deployStatus`: `PENDING → DEPLOYING_TOKEN → DEPLOYING_CAMPAIGN → WIRING → LIVE` (atau `FAILED`).
3. Aktifkan tombol "Invest" di UI hanya jika `deployStatus === "LIVE"` **dan** `status === "ACTIVE"`.

**Endpoints:**

| Method + Path | Catatan |
|---|---|
| `GET /campaigns` | public; hanya mengembalikan *Campaign* berstatus **LIVE** |
| `GET /campaigns/:id` | public; lakukan *polling* `deployStatus` / `status` di sini |

**Catatan Penting:**
- **Kunci aksi "Invest" berdasarkan kombinasi `deployStatus === "LIVE"` dan `status === "ACTIVE"`** — jangan hanya mengecek keberadaan `contractAddress`. Jika tidak, *endpoint* invest-prepare akan menghasilkan *error* 409.
- **Urutan whitelist Investor (sangat penting):** *Wallet* seorang *Investor* harus ditambahkan ke sistem registri kepatuhan (*compliance registry*) *on-chain* sebelum fungsi `invest()` berhasil dieksekusi. Ini terjadi secara otomatis setelah KYC disetujui lewat proses asinkron terpisah, yang dilacak melalui `KycProfile.whitelistStatus` (`NOT_SYNCED → ADDING → WHITELISTED`) — **saat ini field tersebut tidak diekspos pada `GET /kyc/me`**. Jadi, jika aksi `invest` pertama seorang *Investor* gagal tepat sesaat setelah KYC mereka disetujui, kemungkinan besar sinkronisasi *whitelist* *on-chain* belum selesai — tampilkan pesan "silakan coba lagi dalam beberapa saat" (*retry/backoff message*), bukan peringatan *error* sistem (karena *contract* menolak fungsi `invest()` untuk alamat yang belum masuk *whitelist*).

---

## Flow 5 — Investor: Invest di sebuah Campaign

Menggunakan Pola Relay (lihat bagian Konsep Utama). Membutuhkan *role* `INVESTOR` + KYC yang sudah disetujui (`ApprovedInvestorGuard`) serta *Campaign* bersatus `LIVE/ACTIVE`.

**Langkah-langkah:**
1. Lakukan `prepare` bersama nominal uang → `{ campaignId, xdr }`.
2. *Wallet* menandatangani XDR tersebut.
3. `submit` XDR yang sudah di-*sign* → menghasilkan `Investment` yang `CONFIRMED` (sinkron, tidak perlu *polling*).
4. Baca riwayat *holdings/history* sesuai kebutuhan.

**Endpoints:**

| Langkah | Method + Path | Body → Return |
|---|---|---|
| 1 | `POST /campaigns/:campaignId/investments/prepare` | `{ amount }` → `{ campaignId, xdr }` |
| 3 | `POST /campaigns/:campaignId/investments` | `{ signedXdr }` → `Investment { id, campaignId, amount, lpTokens, txHash, status, investedAt }` |
| 4 | `GET /investments/mine` | riwayat pembelian milik pemanggil API |
| 4 | `GET /holdings/mine` | saldo turunan *on-chain* secara **live** |

**Catatan Penting:**
- **`amount` menggunakan satuan USDC, bertipe string, maksimal 7 desimal, dan harus > 0.**
- **Shares (`lpTokens`) dicetak (*minted*) dengan rasio 1:1 terhadap USDC** pada saat waktu konfirmasi.
- **Wallet membutuhkan trustline USDC + saldo yang cukup sebelum memanggil `prepare`** — backend tidak melakukan pra-pengecekan; *contract*-lah yang akan menolak transaksi pada saat `submit`. Informasikan hal ini secara jelas di UI Anda.
- **Shares (saham) tidak dapat ditransfer selama periode lock** (*restricted* SEP-41) — jangan buat UI untuk menjual/mentransfer saham.
- **`status` akan menjadi `CONFIRMED` setelah fungsi submit berhasil** (proses submit ini berjalan sinkron — tidak ada *polling* di sini, berbeda dengan proses *deploy*).
- **Untuk data portofolio/kepemilikan, selalu utamakan penggunaan `GET /holdings/mine`** daripada menjumlahkan total dari `/investments/mine` — *endpoint* yang kedua tersebut adalah buku besar riwayat pembelian, bukan cerminan kepemilikan saham riil saat ini.

---

## Flow 6 — Entrepreneur: Distribusi Dividen (Deposit Profit)

Menggunakan Pola Relay. Membutuhkan *role* `ENTREPRENEUR` + KYC yang disetujui, dan *user* pemanggil haruslah pemilik dari *Campaign* tersebut (pengecekan otomatis memastikan `proposal.entrepreneurId`).

**Langkah-langkah:**
1. Lakukan `prepare` dengan memasukkan nominal *profit* → `{ campaignId, xdr }`.
2. *Wallet* menandatangani XDR.
3. `submit` → akan **langsung** mengembalikan data dengan `status: "PENDING"`.
4. Lakukan *polling* terhadap distribusi tersebut hingga `status === "COMPLETED"` (sebuah sistem *background job* akan membangun *Merkle snapshot* + melakukan *post* `set_distribution` secara *on-chain*) **sebelum** memberitahu *Investor* bahwa dividen sudah dapat di-*claim*.

**Endpoints:**

| Langkah | Method + Path | Body → Return |
|---|---|---|
| 1 | `POST /campaigns/:campaignId/distributions/deposit/prepare` | `{ amount }` → `{ campaignId, xdr }` |
| 3 | `POST /campaigns/:campaignId/distributions/deposit` | `{ signedXdr }` → `ProfitDistribution { id, onchainId, totalAmount, status: "PENDING", ... }` |
| 4 | `GET /campaigns/:campaignId/distributions` | melihat semua daftar distribusi untuk suatu *Campaign* (bersifat *public*) |

**Catatan Penting:**
- **`amount` adalah profit berbentuk USDC, bertipe string, > 0**; *Wallet* harus memiliki saldo USDC tersebut (ketentuan *trustline/balance* yang sama dengan proses invest).
- **Fungsi submit mengembalikan status PENDING; proses on-chain berjalan secara asinkron.** Lakukan *polling* sampai `COMPLETED` — distribusi yang masih `PENDING` belum memiliki data *claim* yang bisa diambil.
- **`totalShares` / `rewardPerShare` / `merkleRoot` baru akan terisi setelah proses background job selesai** — anggap nilai-nilai ini kosong (*absent/loading*) saat status masih `PENDING`.
- **Hak pembagian (entitlements) di-snapshot dari pemilik saham terkini secara tepat pada waktu konfirmasi deposit** (pembagian rata / *pro-rata* yang dibulatkan ke bawah) — tidak perlu mengelola tanggal seperti "berlaku sejak tanggal X"; hal ini ditangani secara otomatis.

---

## Flow 7 — Investor: Klaim Dividen

Menggunakan Pola Relay. Membutuhkan *role* `INVESTOR` + KYC yang disetujui.

**Langkah-langkah:**
1. Tarik daftar hak pembagian (*entitlements*) untuk mencari data (*row*) yang dapat di-*claim*.
2. Lakukan `prepare` sebuah *claim* untuk suatu distribusi → `{ distributionId, xdr }`.
3. *Wallet* menandatangani XDR.
4. `submit` → `status: "CLAIMED"`; USDC akan masuk langsung ke dalam *Wallet* di level *on-chain*.

**Endpoints:**

| Langkah | Method + Path | Body → Return |
|---|---|---|
| 1 | `GET /distributions/mine` | `DistributionClaim[] { id, distributionId, amount, status, distribution: { onchainId, campaignId, status } }` |
| 2 | `POST /distributions/:distributionId/claim/prepare` | (tanpa body) → `{ distributionId, xdr }` |
| 4 | `POST /distributions/:distributionId/claim` | `{ signedXdr }` → `DistributionClaim { ..., status: "CLAIMED", claimTxHash, claimedAt }` |

**Catatan Penting:**
- **Tampilkan tombol "Claim" hanya ketika status claim tersebut `status === "PENDING"` DAN bersarang (*nested*) di bawah `distribution.status === "COMPLETED"`** — `prepare` akan mengembalikan 409 jika *Merkle root* belum tercatat (distribusi masih `PENDING`) atau jika tidak ada baris data *entitlement* (memiliki nol saham saat waktu *snapshot*; datanya sekadar tidak akan muncul di `/distributions/mine`).
- **Proses klaim tidak dibatasi waktu** — dividen yang belum di-*claim* akan tetap dapat di-*claim* selamanya (tidak ada *expiry/reclaim*); Anda tidak perlu membuat UI "kadaluarsa dalam X hari".
- **`amount` merupakan nilai entitlement yang baku (tetap)**, dikunci oleh *Merkle tree* di sisi server — *Investor* tidak bisa mengubah atau mengambil sebagian uang (*partial amount*).
- **Tidak ada langkah "withdraw" yang terpisah** — USDC akan otomatis mendarat di *Wallet* sesaat setelah aksi *claim* berhasil.

---

## Cheat-sheet Field Status

Panduan tentang status apa saja yang perlu di-*polling* dan apa maknanya, berguna untuk menentukan *loading/empty states* di frontend.

| Entitas | Field | Nilai yang relevan untuk Frontend |
|---|---|---|
| KYC | `KycProfile.status` | `PENDING` (menunggu) → `APPROVED` (terbuka) / `REJECTED` / `REVOKED` (diblokir, harus *resubmit*) |
| Proposal | `Proposal.status` | `DRAFT` (bisa diedit) → `SUBMITTED` → `UNDER_REVIEW` → `APPROVED` / `REJECTED` |
| Campaign | `Campaign.deployStatus` | `PENDING`…`WIRING` ("sedang di-*deploy*") → `LIVE` (bisa digunakan) / `FAILED` |
| Campaign | `Campaign.status` | `PENDING_DEPLOYMENT` → `ACTIVE` (siap untuk di-*invest*) → `LOCKED` / `GOAL_REACHED` / `COMPLETED` / `CANCELLED` |
| Investment | `Investment.status` | `CONFIRMED` (proses *submit* berjalan sinkron; Anda akan sangat jarang melihat status `PENDING` / `FAILED`) |
| Distribution | `ProfitDistribution.status` | `PENDING` (sedang membangun *Merkle tree* / mem-*posting* ke *on-chain* — akses *claim* belum siap) → `COMPLETED` (bisa di-*claim*) / `FAILED` |
| Claim | `DistributionClaim.status` | `PENDING` (bisa di-*claim*, tampilkan tombolnya) → `CLAIMED` (selesai) |

## Konvensi Error Handling

- **Error yang digunakan adalah Standard Nest HTTP exceptions** dengan struktur body `{ statusCode, message, error }`:
  `400` (validasi/*bad state*), `401` (JWT atau *Wallet signature* salah/hilang/*expired*), `403` (terblokir *role* atau validasi KYC), `404` (tidak ditemukan / bukan milik *user*), `409` (konflik data — *Campaign* tidak bisa di-*invest*, NIK sudah dipakai, klaim sudah di-*claim* sebelumnya).
- **`ValidationPipe` menerapkan fungsi `whitelist`** yang otomatis membuang struktur body (field) yang tidak diketahui dan memaksa tipe data (*type coercion*) — jangan bergantung pada *backend* untuk menolak data ekstra, tetapi Anda wajib mengirim tipe nilai yang benar (angka sebagai `number`, nilai nominal uang sebagai `string`).
- **Segala kegagalan di siklus `/prepare` → sign → `/submit` sangat aman untuk diulang (retry) dari tahap `/prepare`** — tidak akan ada data tersimpan (*persists*) sampai proses *submit* benar-benar sukses.