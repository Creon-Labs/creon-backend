# Creon Soroban contracts

Rust/Soroban smart contracts for the Creon crowdfunding platform. This is a
**standalone Cargo workspace** — it is intentionally kept out of the pnpm/Nest
build. See [`../docs/SMART_CONTRACT_PLAN.md`](../docs/SMART_CONTRACT_PLAN.md) for the
phased plan and [`../docs/ARCHITECTURE.md`](../docs/ARCHITECTURE.md) for the domain
decisions.

## Contracts

| Crate | Kind | Responsibility |
|---|---|---|
| [`compliance-registry`](./compliance-registry) | singleton | KYC whitelist: `add` / `remove` / `is_whitelisted`, owner-gated. The backend (platform key = owner) is the only writer. |
| [`share-token`](./share-token) | per-campaign | Restricted SEP-41 share token on the OpenZeppelin `stellar-tokens` `Base`. `mint` (minter-only) and `transfer`/`transfer_from` require the recipient to be whitelisted; transfers are disabled while the lock flag is set. Shares are non-burnable. |
| [`campaign`](./campaign) | per-campaign | Merged vault + lifecycle + distribution: `invest` (whitelist-gated, USDC custody + mint), `release_to_business`, `unlock`, `deposit_profit`, `set_distribution(merkle_root)`, `claim(proof)` with on-chain commutative SHA-256 Merkle verification. |

Cross-contract calls use minimal locally-declared `#[contractclient]` interfaces, so
the contracts have no inter-crate runtime dependencies. USDC is any Stellar Asset
Contract (SAC), called via the SDK's built-in `token::TokenClient`.

## Toolchain

- Rust (stable) with the `wasm32v1-none` target
- [`stellar` CLI](https://developers.stellar.org/docs/tools/cli) 27+
- OpenZeppelin `stellar-tokens` / `stellar-access` / `stellar-macros` `0.7.2`
  (requires `soroban-sdk` `26`), pinned in the root `Cargo.toml`.

## Build & test

```bash
cargo test            # unit + integration tests (host target)
stellar contract build # -> target/wasm32v1-none/release/{compliance_registry,share_token,campaign}.wasm
```

## Deploy (testnet)

Recorded addresses + WASM hashes live in [`deployments/testnet.json`](./deployments/testnet.json).

```bash
# 1. funded deployer identity (also the platform owner)
stellar keys generate creon-deployer --network testnet --fund
DEP=$(stellar keys address creon-deployer)

# 2. build, then deploy the singleton registry + upload the per-campaign WASM
stellar contract build
REG=$(stellar contract deploy --wasm target/wasm32v1-none/release/compliance_registry.wasm \
  --source creon-deployer --network testnet -- --owner "$DEP")
SHARE_HASH=$(stellar contract upload --wasm target/wasm32v1-none/release/share_token.wasm \
  --source creon-deployer --network testnet)
CAMPAIGN_HASH=$(stellar contract upload --wasm target/wasm32v1-none/release/campaign.wasm \
  --source creon-deployer --network testnet)

# 3. test USDC (a Stellar Asset Contract)
USDC=$(stellar contract asset deploy --asset "USDC:$DEP" --source creon-deployer --network testnet)
```

Per-campaign `ShareToken` + `Campaign` instances are deployed from the uploaded WASM
hashes (`stellar contract deploy --wasm-hash <hash> -- <constructor args>`); the
backend automates this in Phase 2.

## Backend integration

The backend consumes `complianceRegistryAddress`, `shareTokenWasmHash`,
`campaignWasmHash`, and `usdcSacAddress` — see the `STELLAR_*` / `*_WASM_HASH` keys in
[`../.env.example`](../.env.example).
