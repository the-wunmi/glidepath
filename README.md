# Glidepath

**Token unlocks are cliffs. Glidepath turns them into a glide path anyone can verify.**

10b5-1-style selling plans for crypto, verified on NEAR: a
[10b5-1 trading plan](https://www.sec.gov/rules-regulations/2022/12/rule-10b5-1-insider-trading-arrangements-related-disclosures)
for token insiders, with no broker and public verification. Token insiders commit
to a sealed selling plan. Nobody else sees the plan, the enrolled tokens move only through it, and
every sale comes with a public receipt that proves it followed the plan.

Built for the NEAR HACKATHON (2026-11). Tracks: privacy, defi, open, security.

## The problem

Every token project has insiders who eventually sell, and every insider sale looks like a betrayal.

- Keyrock's study of 16,000+ token unlocks found about 90% push prices down, and team unlocks average
  about −25% ([source](https://keyrock.com/from-locked-to-liquidity-what-16000-token-unlocks-teach-us/)).
- A public selling schedule gets front-run. In our replay of four large team/investor unlocks
  (ARB, OP, APT, STRK), three of the four tokens did 24–42 points worse than BTC in the 30 days
  *before* the unlock date ([`data/replay/METHOD.md`](data/replay/METHOD.md)).
- Selling quietly can't be verified, which is how the Movement market-maker scandal happened
  ([CoinDesk](https://www.coindesk.com/tech/2025/04/30/the-protocol-inside-movement-s-token-dump-scandal)).

A credible plan needs three things at once: **no way around it, a secret plan, and public proof of
compliance**. A contract can enforce rules but can't keep them secret; a broker can keep them secret
but must be trusted. This project combines a TEE (the secret), a keyless NEAR account (no way
around it) and Chain Signatures + Intents (any token, any chain).

## How it works

1. The founder writes a plan ("sell at most 2% a month, never below $1.50, at random times").
   The browser seals it to the enclave's attested key and publishes only a salted hash.
2. The registry creates a **plan account with zero access keys**. The team allocation is minted
   straight into it at token launch (on NEAR), or into the plan's Chain Signatures address (on an
   EVM chain), so it never sits under an insider's key.
3. The enclave sells inside the plan at unpredictable times through 1Click. For an ERC-20 the
   registry builds the exact transfer and has the MPC network sign it.
4. Every sale leaves an on-chain **receipt**: the enclave's signed request, its yes/no compliance
   answers (attestations from the enclave; the numbers stay sealed), the 1Click quote it used, and
   the hash of exactly what the registry did. Anyone can verify it in the browser.
5. The contract also enforces a **public envelope** (per-sale cap, per-period cap, minimum gap), and
   binds every sale to a **1Click-signed quote** that pays the beneficiary, in the plan's proceeds
   asset, at or above the public floor, refunding only to the plan. These hold even if the enclave
   were compromised, as long as the registered quote key is 1Click's (in this build it is the
   simulator's): a broken enclave could still pick bad moments inside the envelope, but not sell
   more, sell cheaper than the public floor, or redirect the proceeds.
6. Changing or cancelling the plan starts a **public cooling-off**; the old plan keeps running. A
   change not applied within 7 days of taking effect lapses.
7. When the plan ends, the sealed terms and salt can be **revealed** on-chain (automatically if the
   plan chose `end_reveal`, or by the owner from their backup). The registry accepts them only if
   they hash to the day-one commitment, and the verifier page re-checks every sale against the
   actual terms in the browser.

**A real unlock, replayed.** `/unlock` puts ARB's March 2024 cliff next to the same allocation
under a sealed plan. Every transfer comes from Arbitrum One (checked through its public RPC) with an
explorer link; prices are Binance hourly klines; labels say who applied them; costs are the replay
study's impact model and say so. Data: `data/replay/case-arb-2024-03-16.json`, built by
`pnpm --filter @vsp/replay build:results` from `packages/replay/src/case.ts`.

**How is this different from Wakeless or Charter?** They protect the trader; this protects the
holders on the other side of the insider. Wakeless hides how a trader executes their own order;
Charter enforces public rules on a fund. Neither lets an insider prove to everyone else that
they follow a *secret* plan committed in advance, with the allocation locked keylessly from launch on
its native chain and a cooling-off before any change. That proof is the product. No code from other
entries is used.

## Run it (one command)

Needs Node ≥ 24, pnpm 11, Docker. Rust is only needed to rebuild the contracts (prebuilt wasm is in
`contracts/res/`).

```sh
pnpm install
pnpm dev:local    # Postgres on :5437, API on :4400 (starts a local NEAR sandbox and EVM node), web on :3400
pnpm dev          # the same app on NEAR testnet and Sepolia (needs the keys in .env.example)
```

Open <http://localhost:3400>. `pnpm dev:local` needs no keys, accounts or funds, and each start
creates a fresh local world. `pnpm dev` runs against the deployed testnet registry and the real
Chain Signatures signer: it needs a funded testnet relayer account and a Sepolia funder key in
`.env`.

With `pnpm dev:local` running, in a second terminal:

```sh
pnpm demo:full    # the demo script, then the red-team script, then verifies every receipt
```

or step by step: `pnpm demo` (three plans, launches, bypass attempts, sales, a plan change; about
5 minutes because sales happen 1–3 minutes apart), `pnpm redteam` (needs a sale; 25 bypass
attempts, each expected to be refused on-chain with a specific error; writes
`data/redteam/results.json`, shown on the app's red-team page, and exits non-zero otherwise), `pnpm verify-receipts` (checks every receipt
through the read-only RPC proxy). The demo expects a fresh world: restart `pnpm dev` before
running it again.

## Do X → see Y

| Do | See |
|---|---|
| `/` → **See it on a real unlock** (`/unlock`) | ARB's first team and investor cliff (16 March 2024) from the chain: a beneficiary of 15 Arbitrum vesting contracts released 10.63M ARB, forwarded it, and sent 9.46M to an address tagged as a Binance deposit over 12 days, every transfer linked; ARB −25.2% vs BTC −6.1% (Binance hourly). Beside it, the same allocation under a sealed plan: each deposit refused as a sale (`tx_cap_exceeded`), the plan's 12 allowed sales, and modelled impact (labelled a model) |
| Open `/` | Live system status: registry account with **0 access keys**, enclave attestation verified in your browser (labelled *simulated TDX*), the mode of every outside system |
| `/app/new`: fill the builder, review, **Seal and commit** | Plain-English preview of the secret plan next to what the public will see; the commitment hash computed in your browser; a plan account `p<id>.registry.sandbox` with 0 keys |
| Plan page → **Launch token** | The team allocation minted straight into the plan account (NEAR) or the plan's Chain Signatures address (EVM) |
| Plan page → **Try to bypass** → *Move tokens directly* / *Add a key* | Refused on-chain: `only_registry` / no access key |
| Plan page → **Change plan** | A public cooling-off countdown; sales continue under the old plan |
| Wait 1–4 minutes (demo plans sell 1–3 minutes apart) | Sales: signed by the enclave → executed by the registry → (EVM: MPC-signed and broadcast) → settled by 1Click, USDC to the beneficiary |
| `/verify/<id>` → **Verify all** | Each receipt checked in your browser from chain data: enclave signature, allowlist, attestation, request ↔ receipt binding, compliance answers, action hash, MPC signature recovers to the plan's address, EVM transaction on-chain. No plan details shown |
| Simulation panel → offset Coinbase by +20% | The next sale is skipped. The timeline says only that it was skipped: the reason ("price sources disagree") would reveal the sealed tolerance, so it stays inside the enclave |
| Simulation panel → queue `refund` / `stall` | A refunded sale returns tokens to the plan account; a stalled one shows *in doubt* and keeps being checked |
| Simulation panel → enclave down | No sales, no exit; selling resumes when it is back |
| Header → *Acting as* → treasury-dao.sandbox | Plans owned by a keyless Sputnik DAO v2; every owner action is a DAO proposal the council approves |
| Plan ends (or a cancel takes effect) → **Finalize** | The remainder goes to the beneficiary; an `end_reveal` plan publishes its terms, and `/verify/<id>` shows them with each sale checked against them |
| Ended plan → **Reveal the sealed terms** (from this browser's backup or the downloaded file) | The same reveal for plans that chose not to reveal automatically; a backup that does not match the commitment is refused |
| `/evidence` | The unlock replay study on real Binance prices, observed vs modelled kept apart |

## Tests and checks

```sh
pnpm test          # TypeScript unit and service tests (real Postgres, local chains, all simulators)
pnpm lint          # Biome
pnpm typecheck     # tsc across the workspace
cd contracts && bash test.sh             # builds the wasm, then 46 near-workspaces sandbox tests and 64 unit tests (one thread)
pnpm enclave:wasi  # the enclave logic built for WASI, checked against TS-generated vectors under wasmtime
cd contracts && cargo fmt --check && cargo clippy --all-targets -- -D warnings
```

Contract tests cover: keyless plan accounts running pinned code, launch allocations, direct-transfer
and add-key refusals, only attested enclave requests executing, unregistered/revoked/not-yet-active
keys, forged and tampered signatures, replays, envelope caps with a valid enclave signature,
cooling-off on changes and cancels, pause, MPC timeouts rolling back budget and nonce, failed
transfers, caller-paid storage, the registry with its key deleted, and a real Sputnik DAO v2 creating
a plan through a proposal, quotes that are missing, forged or redirected, lapsed changes, sales after
an effective cancel, re-signing an unmined EVM transfer, and MPC signatures that do not recover to
the plan's address, a cancel that cannot be withdrawn once effective, re-signing limited to the
owner or beneficiary with a fee bump and a wait, the proceeds-asset allowlist, and quote-key
rotation keeping old receipts verifiable, a quote that cannot be used twice, a key registered after a
plan that must wait out that plan's own cooling-off, the end-of-plan reveal (accepted once, only
against the commitment), and 1Click's real quote signature: a live 1Click quote verifies under
1Click's published key and a tampered copy does not; tampered, dry, exact-output, wrong-token,
wrong-recipient and over-the-fee-bound quotes are refused. Engine tests (real Postgres, real local chains, all simulators) cover every
money failure path, an EVM transfer stuck below the base fee that the engine re-signs with higher
fees until it mines, and the end-of-plan reveal: refunds, in-doubt 1Click status, failed swaps, enclave down, MPC down,
manipulated prices, prices under the floor. Package tests cover the enclave's refusals, the 1Click
simulator's API shapes, the cross-language test vectors, and the verifier failing on doctored
receipts.

## What is real and what is simulated

| | In this build |
|---|---|
| NEAR | Real: **NEAR testnet** with the deployed registry (the default), or a local sandbox node for tests |
| Contracts (registry, plan account, NEP-141, signer simulator) | Real Rust/near-sdk 5.30 code on a real node |
| Keyless accounts, global contract code, cooling-off, envelope, receipts | Real, enforced on-chain |
| Chain Signatures | On testnet the **real MPC network** (`v1.signer-prod.testnet`). Locally, a signer simulator with the real `sign` interface and key derivation |
| EVM sales | Real EIP-1559 transactions on **Sepolia** (or a local Hardhat chain for tests), signed through Chain Signatures |
| Enclave | **Real on OutLayer testnet** (`ENCLAVE_BACKEND=outlayer`): the Rust enclave runs as a WASI P2 module on OutLayer's TDX workers, with keys from OutLayer's keystore that no operator holds; the registry pinned its key after one attested key-proof run. This is the production default; development and tests use a labelled in-process simulator (each OutLayer run costs about 0.002 NEAR), whose operator could read plans |
| 1Click | **Simulated** (1Click has no testnet) on the real API paths and shapes; it moves real tokens on the chains in use, paying proceeds in a stand-in vUSDC on testnet. Quotes are signed in 1Click's real format (verified against a live quote), with the simulator's own key; 1Click's published key is used only when `ONECLICK_MODE=live` |
| Prices | **Live** Binance and Coinbase (keyless) for listed tokens (NEAR, wNEAR); a demo token has no market, so it is priced on a labelled simulated market |
| Unlock replay | Real historical Binance prices; the market-impact part is a stated model |

## Limits

- It proves how enrolled tokens were handled, not everything the insider does: tokens never
  enrolled and derivative hedges are out of reach.
- On the public settlement path each transfer is visible when it happens; random timing and sizes
  reduce what can be inferred, but hiding sales needs confidential Intents (not built).
- TEE and MPC trust is narrowed (allowlist, activation delay, revocation, on-chain envelope and
  quote binding) but not removed. Both enclaves take chain time, prices and receipts from their host
  and re-check them; the registry's envelope bounds what a lying host could achieve. On OutLayer the
  trust is in its keystore TEE and its owner-approved measurement list; the browser checks the
  pinned measurements and quote hash, while the quote's Intel signature chain is checked with
  OutLayer's verifier, not on-chain.
- Settlement here is public: each sale is a visible transfer when it happens. Wakeless and Charter
  settle in confidential Intents balances on mainnet; that path is not built here.
- Governance (one account locally, a DAO in production) can pause the registry and add enclave or
  quote-signer keys after a public delay; it cannot move tokens or change the code.
- Quotes are signed in 1Click's real format, but locally by the simulator's key; the registry
  binds the quote's terms and bounds its cost on 1Click's own signed USD values, which are
  1Click's estimates, not an independent price. The sealed and public floors still apply.
- Cancelling is allowed, as with a 10b5-1 plan: it is public and waits out the cooling-off.
- OutLayer runs are relayed by an account, not an atomic contract callback; a new module build means
  a new key, a new registration and the registry's activation delay.
- No regulator recognises this as a 10b5-1 plan for tokens.

## Going live: what you would need to provide

### Deploying the registry to NEAR testnet

```sh
pnpm deploy:testnet --local   # rehearses every step on a throwaway local sandbox, then stops it
pnpm deploy:testnet           # the real thing, from DEPLOY_* in .env
```

It creates `<DEPLOY_REGISTRY_NAME>.<DEPLOY_ACCOUNT_ID>` with the registry code, publishes the
plan-account code as a global contract, allowlists the proceeds asset, optionally registers the
enclave key and 1Click quote signer, deletes the registry's own key and checks it has none, then
writes `deployments/testnet.json` (no secrets). It refuses accounts that do not end in `.testnet`.

`pnpm deploy:testnet --publish-demo-token --confirm` publishes the demo token's code once as a
global contract (about 17 NEAR, burnt) and records its hash; until then a testnet server offers
ERC-20 plans only, since each NEAR-token launch would store its own 172 KB copy (about 1.9 NEAR).

You provide: a NEAR testnet account and its private key holding about 20 testnet NEAR (5 fund the
registry, about 13 are burnt publishing the plan-account code as a global contract, the rest pays
gas and storage; free from a testnet faucet), and the proceeds asset id. For ERC-20 plans on
Sepolia: faucet ETH on the funder key, which deploys tokens and gives each plan address its gas.

### Everything else

See `.env.example`. For testnet: a funded relayer account (`RELAYER_ACCOUNT_ID`,
`RELAYER_PRIVATE_KEY`), a Sepolia funder key (`EVM_FUNDER_PRIVATE_KEY`, with faucet ETH), and for the
real enclave `pnpm outlayer:enclave` (build, upload, prove, register). A public server sets
`PUBLIC_ORIGIN` and, for its operator, `OPERATOR_TOKEN`: each plan is managed with the owner key its
creator received once, and daily caps (`MAX_PLANS_PER_DAY`, `MAX_LAUNCHES_PER_DAY`), plan length
(`MAX_PLAN_DAYS`) and reserve floors (`NEAR_RESERVE`, `EVM_RESERVE`) bound what visitors can spend. For 1Click (mainnet only, per the hackathon's Q-007) a partner JWT
(`ONECLICK_JWT`) and its quote-signing key (`ONECLICK_QUOTE_KEY`). Mainnet and real money are out of scope for this build.

## Repository

```
contracts/          Rust: plan-registry, plan-account, mpc-signer-sim, demo-token, integration-tests; res/ prebuilt wasm
enclave-wasi/       the enclave in Rust: the OutLayer P2 module (src/bin/outlayer.rs) and the logic checked against TS vectors
packages/core       plan format, commitments, sealing, attestation, money units (browser-safe)
packages/planner    the enclave's pure decision logic: schedule, budgets, price checks
packages/enclave    the simulated executor enclave
packages/chainsig   Chain Signatures derivation, EIP-1559 building, MPC signing (simulator side)
packages/verify     in-browser receipt verification
packages/oneclick   1Click client + simulator
packages/prices     price sources (live + simulated)
packages/near, evm  chain clients and local nodes
packages/db, engine Postgres schema; services, DBOS workflows, enclave tick loop
packages/replay     unlock replay study
apps/api, apps/web  Hono API (:4400), Next.js app (:3400)
scripts/            demo, red-team, receipt verification, testnet deployment
data/               replay prices and the ARB case, the live 1Click quote fixture, red-team results
deployments/        written by pnpm deploy:testnet (no secrets)
```

## Libraries and prior code

All code was written during the hackathon; there is no pre-hackathon baseline. Libraries:
near-sdk 5.30, near-contract-standards, k256, sha3, uint, near-workspaces (Rust); near-api-js 7,
near-sandbox, viem, Hardhat 3, solc, @noble/curves, @noble/hashes, @noble/ciphers, Zod 4, Hono,
Drizzle, pg, Next.js 16, React 19, Tailwind 4, Vitest, Biome, Turbo. Third-party contract code used
only in tests: Sputnik DAO v2 (MIT), the code the mainnet `sputnik-dao.near` factory deploys today.

## License

MIT, see [LICENSE](LICENSE).
