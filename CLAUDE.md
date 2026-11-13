# Glidepath

The product was called Verified Sales Plans; internal names keep it (`@vsp/*`, the `sales-plans`
folder, database names, the testnet accounts `vsp-registry`/`vusdc`). User-facing text says Glidepath.

A crypto 10b5-1 plan: insiders seal a selling plan in a TEE, their allocation sits in a keyless NEAR
plan account (or its Chain Signatures address on an EVM chain), an enclave sells at random times
inside the plan, and every sale leaves a receipt anyone can verify. NEAR HACKATHON entry, due
2026-11-14 23:59 UTC. Product spec: `../verified-sales-plans.md`. Never say "smart contracts".

## Working rules

- Follow the zyx workspace coding guidelines and their 20-point checklist on every change.
- Never commit, push, create a remote, or touch the git index. Never ask about committing.
- Credentials only in `.env` (see `.env.example`). Mainnet and real money are out of scope.
- Systems we can reach run for real, and by default: NEAR testnet with the real Chain Signatures
  signer, Sepolia for EVM, and exchange prices for listed tokens. `NEAR_NETWORK=local` and
  `EVM_NETWORK=local` (a sandbox and Hardhat) are for tests and offline work. The enclave runs on
  OutLayer testnet (TDX), the production default (`loadConfig`; a plan wakes at most every
  `OUTLAYER_TICK_SECONDS`, 10 minutes, since each run costs about 0.002 NEAR), or as the labelled
  in-process simulator in development and tests. 1Click (no testnet) stays simulated.
  Simulated attestation says "simulated".
- Do not touch `../hustle/` (another project). Ports 3000, 4100, 5434 belong to other projects.

## Run

```sh
pnpm install
pnpm dev            # Postgres :5437 (compose project glidepath), API :4400, web :3400; testnet + Sepolia
pnpm dev:local      # the same on a local NEAR sandbox and Hardhat node
pnpm demo           # scripted demo against the running API
pnpm redteam        # bypass attempts; writes data/redteam/results.json (needs one sale first)
pnpm test && pnpm lint && pnpm typecheck
cd contracts && bash test.sh && cargo fmt --check && cargo clippy --all-targets -- -D warnings
pnpm enclave:wasi   # builds enclave-wasi for wasm32-wasip1, runs TS-generated vectors under wasmtime
pnpm oneclick:vectors   # rebuilds contracts/res/oneclick-quote-vectors.json from the live 1Click fixture
pnpm deploy:testnet --local   # rehearses the testnet deployment on a throwaway sandbox
pnpm replay && pnpm --filter @vsp/replay build:results   # refetch prices, rebuild the study
```

On testnet the API uses the registry in `deployments/testnet.json` (`pnpm deploy:testnet`; keeps
the deployer above `DEPLOY_MIN_BALANCE_NEAR`) and Sepolia through public RPCs, paced with failover.
Locally it starts a fresh NEAR sandbox (:4420) and Hardhat node (:4430) on every start and
redeploys everything (`packages/engine/src/world.ts`). Tests always pin `NEAR_NETWORK=local`. A new genesis hash wipes chain-derived rows and drops DBOS's
system database (`salesplans_dbos`); the enclave's own identity row survives. Logs: `.data/api.log` when started by scripts.

Keep the Postgres database `salesplans_outlayer` (on :5437): it holds the app-side history of
testnet plan #3, the first plan sold by the OutLayer enclave (receipts 0-3, sale #3 settled), as
evidence. An API started with `ENCLAVE_BACKEND=outlayer API_PORT=4410 API_ORIGIN=http://127.0.0.1:4410`
and that DATABASE_URL serves it; set `OUTLAYER_TICK_SECONDS` high to keep it from spending.

## Architecture

- `contracts/` Rust near-sdk 5.30.1: `plan-registry` (commitments, public envelope, cooling-off,
  enclave allowlist, receipts; no upgrade method; key deleted at deploy), `plan-account` (keyless,
  global contract by hash, obeys only the registry), `mpc-signer-sim` (v1.signer interface),
  `demo-token` (NEP-141 with launch allocations). `res/` holds prebuilt wasm (non-reproducible builds:
  hashes change per build) and `test-vectors.json` shared with TypeScript.
- `packages/core` browser-safe domain: plan schema, canonical JSON, commitment, ECIES sealing,
  simulated TDX quote, signed message formats, units (bigint base units, USD e6).
- `packages/planner` pure enclave logic. `packages/enclave` simulated executor (keys from a hardware
  secret in `.data/enclave-hardware.key`; state sealed in `enclave_store`).
- `packages/engine` services (`plans.ts`), DBOS workflows (`durable.ts`, `workflows.ts`), the enclave
  tick loop (`worker.ts`), world bootstrap,
  simulated MPC node (`mpc-node.ts`), 1Click simulator rails (`rails.ts`), read models (`views.ts`).
- `enclave-wasi/` the enclave's decision logic in Rust for WASI (OutLayer); stdin/stdout JSON;
  production build refuses host-chosen random seeds and `sign`. `vectors.json` comes from the TS code.
- `scripts/deploy-testnet.ts` testnet deployment from `DEPLOY_*` in `.env` (refuses non-.testnet).
- `packages/oneclick` client + simulator on the real paths. `packages/verify` in-browser receipt
  checks. `packages/replay` the unlock replay study (data in `data/replay`) and the demo's real
  case (`src/case.ts`: ARB 2024-03-16, flows read from Arbitrum One via RPC, cited; `/unlock` page).
- `apps/api` Hono; `/rpc/near` and `/rpc/evm` are read-only proxies for the verifier page.
  `apps/web` Next.js 16.

## Decisions

- The server never sees a plan: the browser seals `{plan, salt}` to the attested enclave X25519 key
  and computes `sha256(canonical_json(plan) ‖ salt)`.
- The registry enforces a public envelope in absolute token amounts (no oracle): per-sale cap,
  per-period cap, minimum gap, and a floor on the quote's `min_amount_out`. Every sale carries a
  1Click quote in 1Click's own format (ed25519 over base58(sha256(Q)), Q = stable-stringified quote;
  `packages/core/src/oneclick-quote.ts`), signed by the registered quote signer (the simulator's key
  locally, 1Click's published key in live mode). The registry verifies it with `env::ed25519_verify`,
  then binds Q: live exact-input, this amount and deposit address, refunds to the plan, pays the
  beneficiary in the plan's `proceeds_asset`, `minAmountOut` as the floor input, deadline, and a cost
  bound on the signed USD values (50 bps + $1; `appFees` is unsigned). `correlation_id` is not
  signed. A compromised enclave is bounded by both. The sealed plan must sit inside the envelope;
  the enclave checks before acking.
- Enclaves and the quote signer wait an activation delay of at least one cooling-off, and a key
  registered after a plan was created acts for it only after that plan's own cooling-off
  (`key_too_new_for_plan`); so the bootstrap registers keys before any plan exists. Each quote is
  usable once (`quote_used`, sha256 of the payload, kept until its deadline, at most 7 days ahead).
- The engine re-signs stuck EVM transfers itself (`broadcast_evm` workflow → `resign_evm` after
  `EVM_STUCK_BLOCKS`). Finalized `end_reveal` plans are revealed by the `reveal_plan` workflow; owners can
  reveal from their backup (`POST /api/plans/:id/reveal`). `verifyReveal` re-checks sales in the browser. Changes must
  be acked after they take effect and lapse 7 days later. A cancel cannot be withdrawn once
  effective. The owner or beneficiary can re-sign an unmined EVM transfer (`resign_evm`: both fees
  +12.5% or more, 30 blocks after the last signature); anyone can clear a stale signature
  (`clear_stale_sign`). Proceeds assets and their decimals are a governance allowlist; quote keys keep
  a history and each receipt records the key used.
- Owner actions go through `ownerCall` (plans.ts): the founder signs directly; the treasury DAO
  (Sputnik v2, keyless, founder on its council) acts through proposals.
- Skip reasons never leave the enclave (they would reveal the floor); the timeline says only that a
  sale was skipped. Writes to the API need a JSON body and our Origin.
- Plan authorization: `POST /api/plans` returns a random 32-byte `ownerKey` once; the DB keeps its
  sha256 (`plans.owner_key_hash`). Every owner write (launch, enroll, change, cancel,
  withdraw-change, attempts/*) needs `x-plan-key` or `Authorization: Bearer <OPERATOR_TOKEN>`;
  `actor` only picks the signing persona. Finalize and reveal are open. Plans from before keys
  (testnet #1–#3) have no hash: operator only. With PUBLIC_ORIGIN set, an API write with no Origin
  needs the operator token, and `PUT /api/sim` and `/api/sim/advance` are operator only.
- Drain protection (`packages/engine/src/guards.ts`): daily caps in `daily_usage` (UTC day;
  MAX_PLANS_PER_DAY, MAX_LAUNCHES_PER_DAY), charged after validation; testnet reserve floors on the
  relayer's NEAR and the Sepolia funder's ETH (30 s cached reads; `busy`); a per-plan advisory lock
  around a launch; MAX_PLAN_DAYS; EVM gas from the chain's current fee (sales × 150k × fee × 2,
  0.001–0.01 ETH). The OutLayer tick pays for no run when public state rules a sale out (not
  started or ended, min gap, period cap used, no tokens, a signed sale in flight) unless a change
  awaits its ack. NEAR-token plans need the demo token's code published as a global contract
  (local bootstrap does it; testnet: `pnpm deploy:testnet --publish-demo-token --confirm`, ~17 NEAR,
  not run) or NEAR_TOKEN_LAUNCHES=on. Simulated prices are keyed by token address (old symbol keys
  still answer), and a symbol may name only one token.
- One shared daily budget (`relayer_write`, MAX_RELAYER_WRITES_PER_DAY) covers every write the
  relayer pays for. A plan may enroll only the token it launched (`plans.launched_token`), up to
  the founder allocation it minted; no plan may name a token another plan launched, or the
  proceeds token. Finalize and reveal read the registry first and answer 409 when there is nothing
  to do. A repeat of a plan already on chain writes nothing and returns `ownerKey: null`.
- Enclave messages are signed over `DOMAIN ‖ exact JSON string`; receipts store the string, so
  verification needs no canonical form.
- For ERC-20 plans the registry builds the EIP-1559 transfer itself and signs only that
  (never an opaque hash); one signature in flight per plan; nonces enforced.
- Durable work is DBOS (5.3.0, pinned): one workflow per outside job, id = our idempotency key
  prefixed with the genesis hash (the registry on testnet) and started on the rate-limited `chain`
  queue (`startOnce`), DB writes as transaction steps (`inTx`), outside
  effects as steps (`effect`) that read the outside world first so a repeat sends nothing. System DB
  `salesplans_dbos`, dropped on a new world. Execution status moves only through `transition()` in
  `workflows.ts`; 1Click silence is `in_doubt`, polled with durable sleeps, never failed. Crash
  tests: `packages/engine/test/crash.test.ts` (SIGKILL after the effect, before the checkpoint).
- Demo plans sell 1–3 minutes apart; real plans use hours. Local min cooling-off is 10 minutes.
- Sandbox time: `NearClient.fastForward` jumps at most 50 blocks and waits for finality between
  jumps (the validity window is 100 blocks; txs sign against the final block), except at bootstrap
  (`settle: false`). Market prices (feeds and the 1Click simulator) use wall-clock time, not chain
  time, so fast-forwards never compare prices from different moments.

## Provider facts (verified 2026-11-11)

- Chain Signatures: `v1.signer` / `v1.signer-prod.testnet`; `sign({request:{path, payload_v2:{Ecdsa:
  hex32}, domain_id:0}})`, 1 yocto, ≥15 Tgas (live config). Tweak = SHA3-256("near-mpc-recovery v0.1.0
  epsilon derivation:" + predecessor + "," + path), big-endian, rejected if ≥ n; derived = root +
  tweak·G. Our TS and Rust reproduce the live mainnet derived key for example.near/ethereum-1. The
  address the NEAR docs print for that pair (0x1b48…) does not match today's root key; ours
  (0xef4e…) matches viem's own keccak.
- OutLayer: WASI P1/P2 only; results reach a contract through a yield resumed by a registered
  worker; per-call quotes are not verified on-chain; a P2 module can hold an ed25519 key and a
  contract pins it after one attested key-proof run. Secrets: X25519 + HKDF-SHA256 + ChaCha20-Poly1305.
- OutLayer testnet (verified 2026-11-13): `outlayer.testnet` `request_execution` with a WasmUrl
  source (`test.fastfs.io`), about 0.002 NEAR a run, excess refunded. P2 keystore signing and
  encryption keys work. Attestations at `testnet-api.outlayer.ai/attestations/by-tx/<tx>`;
  `output_hash` is sha256 of the tx SuccessValue; `worker_measurement` is RTMR3. A yield timeout
  shows as a null output with the 0.001 NEAR base fee. Workers restart often: retry.
- Sepolia (2026-11-13): an ERC-20 transfer to a new holder costs about 141k gas (43k to an existing
  one), so sales sign the registry's 150k cap. An execute with an MPC signature costs about 0.044 NEAR.
- 1Click quote signature: `ed25519:<base58>` under `reYaWhvwu8Jzo3WUM3zhn6VrhuMEF4eADL17qtRVifc` over the
  text base58(sha256(Q)); verified on a live quote (`data/oneclick/`, vectors in
  `contracts/res/oneclick-quote-vectors.json`, regenerate with `pnpm oneclick:vectors`).
- 1Click: `https://1click.chaindefuser.com` `/v0/tokens|quote|status|deposit/submit`; 12 required quote
  fields; statuses PENDING_DEPOSIT, KNOWN_DEPOSIT_TX, PROCESSING, SUCCESS, INCOMPLETE_DEPOSIT, REFUNDED,
  FAILED; no JWT adds a 20 bps fee (live); no testnet.
- Confidential Intents exist (`confidentiality: basic|advanced`), mainnet only, need a JWT (401
  without).
- Keyless accounts can create sub-accounts and call other contracts (also confirmed in the sandbox).
  Global contract deploys cost 10× storage, burnt. ft_transfer needs exactly 1 yocto.
- Sputnik DAO v2: `act_proposal` needs `proposal` (the kind) as well as `id` and `action`.
- Binance klines are keyless; CoinGecko history beyond 365 days needs a key.

## Unverified

- 1Click 400 error texts and rate limits.
- Chain Signatures latency and per-signature cost; the yield timeout in blocks (sandbox: ~200).
- Confidential Intents token list and fees.

## Not built

Confidential Intents path, an atomic relayer contract for OutLayer (runs are relayed by an
account today), in-browser Intel signature checks of OutLayer quotes, multi-enclave sealed backups (the registry already accepts any allowlisted key), blind-trust and
vault prototypes. The testnet registry is deployed (`deployments/testnet.json`).
