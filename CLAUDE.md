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
- `apps/api` Hono; `/rpc/near` and `/rpc/evm` are read-only proxies for the verifier page. They
  keep answers that cannot change (a receipt in a finalized Sepolia block, logs or calls pinned to
  one, NEAR reads pinned to a block hash, final txs; `rpc-cache.ts`), share identical reads for 2 s,
  and answer 503 + Retry-After when no node could answer, 400 when the node answered with an error.
  Sepolia goes through `publicRpcTransport` (`packages/evm`): per-endpoint pacing, rest after a 429,
  failover; visitors' reads have their own budget. `eth_call`/`eth_getLogs` are allowed on plan tokens
  only: those in our database plus those on the registry (read once a minute), so plans made before
  or without this server's database still verify. The browser reads 3-4 at a time and retries
  429/502/503/network with backoff (`@vsp/verify/reads`); a read that still fails shows "could not
  be checked" with a retry, never "not broadcast". `apps/web` Next.js 16.
- Labs (footer only, `/labs`): `contracts/btc-vault` is a coercion-safe Bitcoin vault prototype. A
  vault is a testnet4 P2WPKH address derived for (vault contract, creator's path); owner withdrawals
  wait a public delay (contract floor 1 min, `min_delay_ms` per deployment), any guardian can veto
  before signing or claw back to the fixed recovery address with no delay, anyone executes after
  the delay. The contract builds the tx (dest + change to itself, version 2, every input RBF) and
  each BIP143 sighash itself, signs inputs as one joint promise → `on_signed` (ecrecover against
  the vault key). Rules: one open withdrawal and one open claw-back per vault, ≤4 inputs, outputs
  ≥546 sats, fee ≥1 sat/vB and ≤25 (withdrawals) or ≤200 (claw-backs) sat/vB of the estimated
  vsize; a claw-back over coins of a withdrawal that started signing must pay its fee + 1 sat/vB
  (BIP125; `fee_below_replacement`). Veto only before the first signing round (`signing_started`:
  a failed round may still have published signatures); a claw-back cancels only such withdrawals.
  No spend may use coins of another that is signing (`inputs_overlap`). BIP143 signatures combine
  only within one hashPrevouts+hashOutputs, so `bound_txs` maps sha256 of those two to the amounts
  first sent for signing; the same coins and outputs with other amounts are refused
  (`input_amount_mismatch`), while a corrected request (other outputs) is allowed, so a wrong
  amount freezes nothing. Destinations: P2WPKH, P2WSH, P2TR (v1, 32 bytes), P2PKH, P2SH; other
  witness versions are refused. No upgrade method, key deleted at deploy. Taproot (all amounts signed)
  needs Schnorr, which this path does not use. `packages/btc` mirrors it in TS (address, BIP143,
  witness assembly with low-s, mempool.space client); `contracts/res/btc-vault-vectors.json` is
  shared (BIP143's own P2WPKH example, BIP173/350 addresses, a vault spend). `pnpm vault:deploy`
  (dry run unless `--confirm`; `deployments/vault-testnet.json`: `btc-vault.zyx-dev.testnet`,
  deployed 2026-11-14, vault #1, guardian `vault-guardian.zyx-dev.testnet`), `pnpm vault:demo`
  (`VAULT_MEMPOOL_API` names another testnet4 Esplora server; testnet, or
  `--local` rehearsal with the signer simulator and made-up UTXOs; `--rpc` onto the dev:local
  sandbox writes the git-ignored `deployments/local-vault.json`). `GET /api/vault` serves the
  record for the server's network; `/labs/vault` reads the chain through `/rpc/near` and
  mempool.space directly from the browser.
- Labs: `contracts/blind-trust` is a blind trust prototype for officials. A trust holds a commitment
  to a sealed mandate (`@vsp/trust`: universe with sectors, excluded sectors, target weights, band,
  trade sizes, beneficiary, end), a public envelope (excluded 1Click asset ids, turnover cap per
  period in USD e6 measured on the quote's signed `amountInUsd` rounded up, min gap), a keyless trust
  account `t<id>.<contract>` running the plan account code by global hash (`new(registry: contract,
  token: null)`: deposits arrive by plain `ft_transfer`), and a term. Trades are enclave-signed over
  `vsp/trust-trade/v1\n` ‖ JSON (acks `vsp/trust-ack/v1\n`): seq, held origin token, quote in
  1Click's format (shares `oneclick.rs`/`events.rs` with the registry by `#[path]`), recipient and
  refund = the trust account, deposit/refund `ORIGIN_CHAIN` and recipient `DESTINATION_CHAIN`
  (`routes_on_chain`, `quote_routing`; the registry code checks it too, the deployed testnet
  registry does not), destination not excluded (envelope ids must be `nep141:<account>`), cost
  ≤ 50 bps with no flat part, ≥ $10 of `amountInUsd` (`trade_too_small`), `minAmountOut` ≥
  floor(99% of `amountOut`), turnover cap, gap ≥ 1 minute (`MIN_GAP_MS`, in `validate_envelope`);
  the quote key must predate the trust (`key_too_new_for_trust`). A newly bought token joins
  `holdings` (≤12) at once, the trust account is registered on it first (`storage_deposit` →
  `on_registered` → send), and a failed trade removes it again (`added_holding`). The engine charges
  `spendRelayer` (the reserve floor) per relayed trade, refuses gaps under a minute at creation, and stops waking
  trusts once `trusts.ended_at` is set. No owner method moves
  assets; `propose_envelope`/`cancel` wait the cooling-off (an envelope change applies lazily, also
  in views); `finalize` after the end or an effective cancel, then anyone `release`s each holding to
  the beneficiary. Decision (`decideRebalance`, TS and Rust `trust.rs`, vectors in `pnpm enclave:wasi`):
  sell the most overweight holding (anything not an effective target always counts), buy the most
  underweight target, size min(gaps, max trade, turnover left), hold below min trade; hold reasons
  other than gap/turnover/not-started never leave the enclave. Engine `src/trusts/` (local world
  bootstrap `bootstrapTrustWorld` with five demo tokens owned by the solver, priced on the simulated
  market; `trust_created`/`trust_trade`/`trust_release` workflows; `startTrustWorker` every 15 s;
  tables `trusts`, `trust_trades`); the simulated trust enclave shares the plan enclave's keys;
  `ModuleTrustEnclave` runs the enclave-wasi ops (tests: `vsp-enclave-local`; with
  `ENCLAVE_BACKEND=outlayer`, `trustEnclaveOf` runs them on the current OutLayer build, the key
  the page seals to; no backup fallback for trusts, and each 15 s wake-up is a paid run). API `/api/trusts`
  (`apps/api/src/trust.ts`), page `/labs/trust` (seal + create) and `/labs/trust/<id>` (total value,
  attested statements, rules, receipts with Verify all, proof). `pnpm trust:deploy` (dry run unless
  `--confirm`; `--tokens`, `--outlayer` registers the current build and its backups, `--local`)
  writes `deployments/trust-testnet.json`, which the server loads on testnet: `vsp-trust.zyx-dev.testnet`
  (deployed 2026-11-14 with the five `labs-*` tokens, keys `J3prhAPX…` and backup `8pfjqtyg…`).

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
  `EVM_STUCK_BLOCKS`). An ended ERC-20 plan's remainder goes out through the `release_evm` workflow
  (started by finalize, keyed by `next_seq`, so a later finalize retries): the owner asks the registry
  for one MPC-signed transfer of the whole balance to `beneficiary.evm_address`, the engine tops up
  the plan address's gas if short, sends it and watches it like a sale. The registry's own `finalize`
  pays out NEP-141 balances only. The verifier rebuilds a release's transfer from the receipt.
  Finalized `end_reveal` plans are revealed by the `reveal_plan` workflow; owners can reveal from
  their backup (`POST /api/plans/:id/reveal`). `verifyReveal` re-checks sales in the browser. Changes must
  be acked after they take effect and lapse 7 days later. A cancel cannot be withdrawn once
  effective. The owner or beneficiary can re-sign an unmined EVM transfer (`resign_evm`: both fees
  +12.5% or more, 30 blocks after the last signature); anyone can clear a stale signature
  (`clear_stale_sign`). Proceeds assets and their decimals are a governance allowlist; quote keys keep
  a history and each receipt records the key used.
- Owner actions go through `ownerCall` (plans.ts): the founder signs directly; the treasury DAO
  (Sputnik v2, keyless, founder on its council) acts through proposals.
- `planEnclave` (web) returns the build that accepted a plan, or null when its key has no attestation
  served (testnet plans #1 and #2, accepted by this machine's simulated enclave during bring-up; its
  quote was regenerated when the measured sources changed, so it cannot be served again). The page
  then says so instead of borrowing the current build's evidence; the verifier still fails their
  attestation check, by design.
- Skip reasons never leave the enclave (they would reveal the floor); the timeline says only that a
  sale was skipped. Writes to the API need a JSON body and our Origin.
- Plan authorization: `POST /api/plans` returns a random 32-byte `ownerKey` once; the DB keeps its
  sha256 (`plans.owner_key_hash`). Every owner write (launch, enroll, change, cancel,
  withdraw-change, attempts/*) needs `x-plan-key` or `Authorization: Bearer <OPERATOR_TOKEN>`;
  `actor` only picks the signing persona. Finalize and reveal are open. Plans from before keys
  (testnet #1–#3) have no hash: operator only. With PUBLIC_ORIGIN set, an API write with no Origin
  needs the operator token, and `PUT /api/sim` and `/api/sim/advance` are operator only.
- Founders' wallets (docs/WALLET.md): sign-in is NEP-413 (`auth.ts`, session
  cookie `glidepath_session`, `GET /api/me`). A non-persona owner signs every owner action itself:
  `ownerCall` answers `WalletCallNeeded` (409 `wallet_signature_needed` with the exact call), and
  the same request with `x-wallet-tx` is checked on chain (`NearClient.signedTransaction`: signer,
  receiver, method, canonical args, deposit ≥). Release and re-sign of a founder's EVM plan need
  their wallet (`ownerReleaseEvm`/`ownerResignEvm`; workflows note `release_needed` /
  `evm_resign_needed` and wait). `plan_budget` ledger (`budget.ts`): credits are the owner's
  transfers to the relayer (`/fund`, tx counted once), debits a fixed fee per relayed action (runs,
  executes, launch, finalize, reveal); ticks skip a plan under `SALE_RESERVE` (`budget_low`).
  Personas (operator, tests, demo) are never charged. API tests: `apps/api/test/wallet.test.ts`.
- Intel collateral: `/api/pcs/*` passes Intel's PCS collateral through unchanged (TDX TCB Info, QE
  Identity, PCK CRL, Root CA CRL; kept ≤1 h, never past nextUpdate); `@vsp/verify/collateral`
  checks signatures to the pinned root, revocation, and the TCB status (non-UpToDate or a newer
  format Intel publishes is a warning, Revoked or a bad signature a failure). Fixtures in
  `data/intel-pcs/` (excluded from Biome: reformatting breaks the signatures).
- Withheld sales: `GET /api/plans/:id/unsent` lists enclave-signed sales still `signed` 3 minutes
  after signing and not on chain, with the exact `execute` call; the plan page's `UnsentSales`
  lets any signed-in visitor send it with their wallet (the verifier links there). The registry's
  `execute` has no caller check (`flow_tests`: `anyone_can_send_an_enclave_signed_sale…`), and the
  relay workflow treats a request already on chain as executed.
- Abuse protection: no daily caps or plan-length bound (removed 2026-11-14; migration 0006 drops
  `daily_usage`). The API rate-limits per client (20 plans or trusts an hour, 120 writes per 10
  minutes, `apps/api/src/app.ts`); `packages/engine/src/guards.ts` keeps testnet reserve floors on the
  relayer's NEAR and the Sepolia funder's ETH (30 s cached reads; `busy`); a per-plan advisory lock
  around a launch; EVM gas from the chain's current fee (sales × 150k × fee × 2,
  0.001–0.01 ETH). The OutLayer tick pays for no run when public state rules a sale out (not
  started or ended, min gap, period cap used, no tokens, a signed sale in flight) unless a change
  awaits its ack. NEAR-token plans need the demo token's code published as a global contract
  (local bootstrap does it; testnet: `pnpm deploy:testnet --publish-demo-token --confirm`, published 2026-11-14, tx
  `4soajy8X…`, 17.2 NEAR burnt, hash `AoefKus5…` in `deployments/testnet.json`) or NEAR_TOKEN_LAUNCHES=on. Simulated prices are keyed by token address (old symbol keys
  still answer), and a symbol may name only one token.
- A plan may enroll only the token it launched (`plans.launched_token`), up to
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
- Sale sizes (`saleSize`, TS and Rust): random in [cap/2, cap], and a draw never leaves less than
  cap/2 of the period (or balance) behind: the remainder joins the sale when it fits, otherwise
  exactly cap/2 stays. Drawing from what was left instead gave plan #3 a tail of dust sales.
  The OutLayer module published before this (sha256 `bc8448…`) still has the old sizing.
- Enclave builds: OutLayer's keystore gives each wasm build its own keys, so a plan runs on the
  build whose key the registry holds as `acked_by` (`OutLayerEnclave` routes every op;
  `deployments/outlayer-testnet.json` keeps earlier builds in `previous`, and `/api/meta` serves
  them as `pastEnclaves`). New plans and changes go to the current build. Sealed records are stored
  per build (`plan:<id>:outlayer:<signing key>`; the older per-plan key is read for the holder),
  each noting the change it staged, so the build that staged an effective change runs to ack it.
  An owner moves a plan with a change of the same terms (new salt) sealed to the current build
  ("Move to the current enclave" on the plan page, from the browser's backup); the registry lets
  any active key ack a change and sign sales. A build that takes a plan over (stage with no record)
  waits one request lifetime after the change applies, then counts from the registry's counters
  (`handoverState`, TS and Rust). The simulated enclave is a single build with the same logic.
  Published builds: `bc8448…` and `6c9aa4…` predate takeover; `c965f0…` (plan #4) has takeover but
  not the backup recount; the current main build `3c0571…` (key `J3prhAPX…`, registered
  2026-11-14, tx `8Fpthph8…`) and its backup `d5d6c4…` (key `8pfjqtyg…`, tx `2avepJrH…`, same code,
  build slot "backup") carry the recount and the trust ops. Both rebuild byte for byte from this
  source; rustc embeds source line numbers, so even a comment edit in `enclave-wasi` that adds or
  removes a line changes the wasm: keep its line count, or publish a new build. Module errors in
  accept/stage are refusals (`ModuleError`), never retried runs.
- Backups: new plans and changes are also sealed to `backups` builds; each accepts or stages its own
  copy (its ack is not sent). After 2 failed runs in a row the engine runs a backup that follows
  the plan (same commitment, or the same staged change for an ack) and probes the main build every
  30 minutes. Each record notes the registry's `next_seq` (`seen_seq`); sales another key signed
  are recounted from the registry's counters, so the sealed limits hold across builds. Publish a
  backup with `pnpm outlayer:enclave <step> --backup`, always right after its main build.
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
- The Chain Signatures yield timeout in blocks (sandbox: ~200). Measured on testnet 2026-11-14: a
  `sign` answered in 6 blocks (~3.6 s); an execute burns ~0.0017 NEAR of gas.
- Confidential Intents token list and fees.
- The vault's `STALE_SIGN_BLOCKS` (300) assumes the signer's yield times out after ~200 blocks
  (sandbox only).
- The vault on live testnet4: a broadcast of an assembled vault spend (vault #1 is unfunded:
  testnet4 faucets need a captcha or a login) and mempool.space's CORS for browser reads
  (mempool.space is unreachable from the build machine; blockstream.info's testnet4 Esplora, which
  `VAULT_MEMPOOL_API` can name, sends `Access-Control-Allow-Origin: *`). Measured on testnet
  2026-11-14 (probe vault #2, made-up outpoints): one execute with four 40 Tgas `sign` calls to
  `v1.signer-prod.testnet` burns 45.7 Tgas (~0.0043 NEAR) of its 300, returns in ~9 s, and all four
  signatures verify against the vault key.

## Not built

Confidential Intents path, an atomic relayer contract for OutLayer (runs are relayed by an
account today), the
blind trust on OutLayer (no published build has the `trust_*` ops yet) or on testnet (`pnpm trust:deploy --confirm`). The vault contract is not deployed to testnet yet (`pnpm vault:deploy --confirm`). The testnet registry is deployed (`deployments/testnet.json`).
