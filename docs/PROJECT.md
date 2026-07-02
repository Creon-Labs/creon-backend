# Creon — Project Description

> Development context for the Creon backend. Keep this document up to date as the
> project evolves so everyone (and any AI assistant) shares the same understanding.
> Technical decisions (schema, contract design, API surface) live in
> [ARCHITECTURE.md](./ARCHITECTURE.md); this document stays narrative.

## Overview

**Creon** is a web3 crowdfunding ("urun dana") platform for Indonesian micro, small,
and medium enterprises (UMKM), built on **Stellar / Soroban**. It connects
entrepreneurs who need capital with investors who want to fund them — and, unlike a
token-price play, returns profit back to investors as on-chain **dividends** (_bagi
hasil_), not a buyback or secondary-market exit.

An entrepreneur submits a funding proposal, including a milestone breakdown for how
the capital will be released. Once an admin approves it, the backend deploys a
dedicated **campaign** on Soroban — a restricted share token plus a vault/lifecycle
contract — and KYC'd investors fund it with **USDC** (Stellar testnet during
development) in exchange for shares. Capital is released to the business in
pre-committed **milestone** chunks, gated on-chain and voted on off-chain by
investors. Profit the business later deposits is split pro-rata and claimed by
investors against a Merkle proof the contract verifies itself.

`creon-backend` is the backend service for this platform, built with
[NestJS](https://nestjs.com/). It owns proposals, the KYC/approval workflow,
campaign state, and the bridge between the application and the on-chain contracts —
deploying contracts, syncing the KYC whitelist, recording investments, indexing
share ownership, and orchestrating milestone releases and dividend distribution.
The three Soroban contracts live in [`../contracts/`](../contracts/) (see
[`contracts/README.md`](../contracts/README.md) for the on-chain deep-dive).

## Actors / Roles

- **Entrepreneur (UMKM owner)** — Submits a funding proposal describing their
  business, the capital needed, and how it will be released across milestones.
- **Admin** — Reviews KYC submissions and funding proposals; approves or rejects
  them. Only approved proposals get deployed on-chain.
- **Investor** — Passes KYC, browses live campaigns, invests USDC into the ones
  they want to back, votes on milestone releases weighted by their share balance,
  and later claims dividends.

## Core Flow (happy path)

1. **Onboarding** — A user connects a Stellar wallet (wallet-based auth, no
   passwords) and submits **KYC** (identity + ID card / selfie; the same flow for
   entrepreneurs and investors). An admin approves it, which also syncs the wallet
   into the on-chain `ComplianceRegistry` whitelist.
2. **Submission** — An approved entrepreneur drafts and submits a UMKM funding
   proposal off-chain: goal amount, lock period, and a milestone breakdown (amounts
   that sum to the goal).
3. **Review & deploy** — An admin reviews the proposal and approves or rejects it.
   Approval is the deploy trigger: the backend deploys a dedicated **restricted
   share token** and a **campaign contract** on Soroban for this business and wires
   them together, making the campaign live and fundable.
4. **Investment** — Whitelisted (KYC'd) investors fund the live campaign with
   **USDC**, which is held in the campaign contract's own custody (no separate
   pool), and receive **shares 1:1** — a non-transferable token while the lock is
   active.
5. **Milestone release** — Once the campaign is fully funded, the business
   receives capital in **pre-committed, sequential milestone chunks** instead of a
   lump sum. Each release is gated on-chain and requires investors to approve it
   first via off-chain voting weighted by share balance (quorum + majority).
6. **Dividend distribution (bagi hasil)** — As the business earns profit, it
   deposits USDC back into the campaign contract. The backend snapshots current
   shareholdings, computes each investor's pro-rata entitlement, builds a Merkle
   tree, and posts the root on-chain. Investors then **pull** their dividend via
   `claim()`, which the contract verifies against the posted root — the backend
   cannot forge who gets paid what.
7. **Unlock** — After the lock period ends, shares become transferable between
   KYC'd wallets. Dividend claims are not gated by the lock and remain claimable
   indefinitely.

## Key Concepts / Glossary

- **UMKM** — _Usaha Mikro, Kecil, dan Menengah_; Indonesian micro, small, and
  medium enterprises — the businesses seeking funding on Creon.
- **Urun dana** — Indonesian for "crowdfunding": pooling capital from many
  investors to fund a business.
- **Bagi hasil** — Indonesian for "profit sharing": the dividend model Creon pays
  investors, as opposed to a token buyback or price-appreciation exit.
- **Campaign** — An approved funding round for a single UMKM. On-chain, it's a
  single Soroban contract that holds USDC custody, milestone-release logic, and
  dividend distribution together (no separate vault or pool contract).
- **Share (ShareToken)** — A restricted SEP-41 token representing an investor's
  stake in a campaign, minted 1:1 on investment. It can only be held by a
  KYC'd wallet (enforced at both mint and transfer) and is non-transferable until
  the campaign unlocks.
- **ComplianceRegistry** — A single, shared on-chain whitelist of KYC'd wallets
  that every share token checks before minting or transferring — one KYC covers
  every campaign.
- **Milestone** — A pre-committed, fixed-amount slice of the funding goal. Chunks
  are released to the business sequentially, one at a time, only after investors
  vote to approve the release.
- **Lock period** — A window during which invested principal cannot be withdrawn
  and shares cannot be transferred, giving the business stable capital. It does
  **not** block dividend receipt — profit can be claimed during the lock.
- **Merkle-pinned dividends** — Each distribution's entitlements are computed
  off-chain, hashed into a Merkle tree, and pinned by posting only the root
  on-chain; investors claim with a proof the contract verifies itself, so the
  backend cannot alter amounts after the fact.
- **USDC** — A US-dollar-pegged stablecoin used as the investment and dividend
  asset. A test USDC asset (Stellar Asset Contract) is used on testnet during
  development.
- **Stellar** — The blockchain network Creon is built on.
- **Soroban** — Stellar's smart-contract platform, used for the compliance
  registry, share tokens, and campaign contracts.
- **Testnet** — A test network that mirrors mainnet for development and testing
  without using real funds.

## Project Status

Past the early-stage scaffold. Built and unit-tested: persistence (Prisma +
Postgres), wallet-based auth, role-agnostic KYC + admin approval, entrepreneur
proposals with milestone authoring, on-chain campaign deploy (share token +
campaign contract), KYC whitelist sync, investment recording, the ownership
indexer, milestone-gated release (on-chain + off-chain voting), and dividend
distribution + claim (Merkle snapshots). The three Soroban contracts are deployed
to **testnet** and were verified end-to-end on-chain.

Remaining, tracked in [ARCHITECTURE.md](./ARCHITECTURE.md#build-roadmap): a full
on-chain e2e run needs a funded platform signing key, and the deployed `Campaign`
WASM predates the milestone-release constructor change, so a redeploy is pending
before milestone releases can run against a live testnet campaign.

This document intentionally stays high-level and narrative; technical decisions
(database, auth strategy, contract design, API surface) are documented separately
in [ARCHITECTURE.md](./ARCHITECTURE.md) and [SMART_CONTRACT_PLAN.md](./SMART_CONTRACT_PLAN.md).
