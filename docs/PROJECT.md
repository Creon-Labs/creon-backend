# Creon — Project Description

> Development context for the Creon backend. Keep this document up to date as the
> project evolves so everyone (and any AI assistant) shares the same understanding.

## Overview

**Creon** is a web3 crowdfunding ("urun dana") platform for Indonesian micro, small,
and medium enterprises (UMKM), built on the **Stellar network**. It connects
entrepreneurs who lack or need capital with investors who want to fund them.

An entrepreneur submits a funding proposal for their business. Once an admin
approves it, a funding **campaign** is created on a Stellar smart contract, and
investors can fund that campaign. All investments are denominated in **USDC**
(using Stellar **testnet** during development).

`creon-backend` is the backend service for this platform, built with
[NestJS](https://nestjs.com/). It is responsible for managing proposals, the
approval workflow, campaigns, and the bridge between the application and the
on-chain smart contracts.

## Actors / Roles

- **Entrepreneur (UMKM owner)** — Submits a funding proposal describing their
  business and how much capital they need.
- **Admin** — Reviews submitted proposals and approves or rejects them. Only
  approved proposals proceed on-chain.
- **Investor** — Browses approved, live campaigns and invests USDC into the ones
  they want to back.

## Core Flow (happy path)

1. **Submission** — An entrepreneur submits a UMKM funding proposal (off-chain).
2. **Review** — An admin reviews the proposal and approves or rejects it.
3. **Campaign creation** — On approval, a **campaign is created on a Stellar smart
   contract**, making it live and fundable.
4. **Pool creation** — Once approved, a **liquidity pool is created pairing the
   campaign's project token with USDC** (the investor capital). This pool
   represents the funded relationship between the business and its investors.
5. **Pool lock** — The pool is **locked for a defined period** so the business has
   stable capital while it is being built and ramped up; funds cannot be withdrawn
   from the pool until the lock period ends.
6. **Investment** — Investors fund the live campaign using **USDC**, which flows
   into the paired pool.
7. **Settlement** — Once the lock period ends and the campaign reaches its goal or
   ends, funds are settled according to the campaign's lifecycle rules (the exact
   settlement model is still to be defined).

## Key Concepts / Glossary

- **UMKM** — _Usaha Mikro, Kecil, dan Menengah_; Indonesian micro, small, and
  medium enterprises — the businesses seeking funding on Creon.
- **Urun dana** — Indonesian for "crowdfunding": pooling capital from many
  investors to fund a business.
- **Campaign** — An approved funding round for a single UMKM, represented on-chain
  via a Stellar smart contract.
- **Project token** — A token representing a specific campaign/business, paired
  against USDC inside the campaign's liquidity pool.
- **Liquidity pool** — An on-chain pool pairing a campaign's project token with
  USDC. Investor capital flows into this pool to fund the business.
- **Lock period** — A defined window during which the pool is locked and funds
  cannot be withdrawn, giving the business stable capital while it is being built.
- **USDC** — A US-dollar-pegged stablecoin used as the investment asset. A test
  USDC asset will be used on Stellar testnet during development.
- **Stellar** — The blockchain network Creon is built on.
- **Soroban** — Stellar's smart-contract platform, used to represent and manage
  campaigns on-chain.
- **Testnet** — A test network that mirrors mainnet for development and testing
  without using real funds.

## Project Status

Early-stage. The backend is currently a minimal NestJS scaffold. The following are
**not yet implemented** and remain open for design:

- Persistence layer (database / ORM)
- Authentication and authorization
- On-chain integration (Stellar SDK / Soroban smart contracts)
- Test USDC asset setup on testnet

This document intentionally stays high-level and narrative; technical decisions
(database, auth strategy, contract design, API surface) will be documented
separately as they are made.
