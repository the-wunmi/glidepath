/**
 * Puts the enclave on OutLayer testnet and registers its key on the deployed registry.
 *
 *   pnpm outlayer:enclave build      # the wasm32-wasip2 module, with the registry's quote key built in
 *   pnpm outlayer:enclave upload     # publishes it on FastFS (an https URL, no GitHub)
 *   pnpm outlayer:enclave prove      # one attested key-proof run; checks it; writes the record
 *                                    # (--tx <hash> re-checks an earlier run)
 *   pnpm outlayer:enclave register   # governance pins the key with the run's real measurements
 *
 * Each step takes `--backup` to publish a backup build of the same code instead: a different wasm
 * (its build slot is baked in), so the keystore gives it its own keys. New plans are sealed to it
 * too, and it stands in when the main build cannot run. Publish the main build first; a backup
 * must run the same code as the build it stands in for.
 *
 * The module's keys live in OutLayer's keystore, bound to this exact build and to the calling
 * account (the relayer), so a new build means a new key and a new registration. Writes
 * deployments/outlayer-testnet.json (no secrets). Every step that spends checks the account keeps
 * OUTLAYER_MIN_BALANCE_NEAR (it is shared with the running app).
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fromBase64, parseNearKey, sha256Hex, utf8ToBytes } from '@glidepath/core';
import {
  checkAttestation,
  OutLayerClient,
  OutLayerDeployment,
  type RunResult,
} from '@glidepath/engine';
import { actions, type KeyPairString, NearClient } from '@glidepath/near';
import { ed25519 } from '@noble/curves/ed25519.js';

const NEAR = 10n ** 24n;
const CONTRACT = 'outlayer.testnet';
const API = 'https://testnet-api.outlayer.ai';
const WORKER_REGISTRY = 'worker.outlayer.testnet';
const FASTFS_HOST = 'https://test.fastfs.io';
const KEY_PROOF_DOMAIN = 'glidepath/key-proof/v1\n';
/** register_enclave's storage deposit; the registry keeps what the entry uses. */
const REGISTER_DEPOSIT = NEAR / 10n;

const root = new URL('../', import.meta.url).pathname;
const wasmPath = `${root}enclave-wasi/target/wasm32-wasip2/release/glidepath-enclave-outlayer.wasm`;
const recordPath = `${root}deployments/outlayer-testnet.json`;

const optional = (k: string): string | undefined => process.env[k] || undefined;
const backup = process.argv.includes('--backup');
const ledgerPath = optional('OUTLAYER_LEDGER');
const env = (k: string) => {
  const v = optional(k);
  if (!v) throw new Error(`${k} is not set in .env`);
  return v;
};
const minBalance =
  BigInt(Math.round(Number(optional('OUTLAYER_MIN_BALANCE_NEAR') ?? '4.5') * 1e6)) * 10n ** 18n;

const near = new NearClient(optional('DEPLOY_NEAR_RPC_URL') ?? 'https://test.rpc.fastnear.com');
const caller = near.account(env('RELAYER_ACCOUNT_ID'), env('RELAYER_PRIVATE_KEY') as KeyPairString);
const testnet = JSON.parse(readFileSync(`${root}deployments/testnet.json`, 'utf8')) as {
  registry: string;
  governance: string;
  quote_signer: string;
};

function note(step: string, txHash: string) {
  console.log(`  ✓ ${step}  tx ${txHash}`);
  if (ledgerPath) writeFileSync(ledgerPath, `${step} ${txHash}\n`, { flag: 'a' });
}

async function keepBalance(spend: bigint) {
  const state = await near.accountState(caller.accountId);
  const balance = BigInt(state.amount);
  if (balance - spend < minBalance)
    throw new Error(
      `Stopping: ${caller.accountId} would drop below ${Number(minBalance / 10n ** 18n) / 1e6} NEAR`,
    );
}

function build() {
  execFileSync(
    `${process.env.HOME}/.cargo/bin/cargo`,
    [
      'build',
      '--release',
      '--target',
      'wasm32-wasip2',
      '--features',
      'outlayer',
      '--bin',
      'glidepath-enclave-outlayer',
    ],
    {
      cwd: `${root}enclave-wasi`,
      stdio: 'inherit',
      env: {
        ...process.env,
        GLIDEPATH_QUOTE_SIGNER_KEY: testnet.quote_signer,
        ...(backup ? { GLIDEPATH_BUILD_SLOT: 'backup' } : {}),
      },
    },
  );
  const bytes = readFileSync(wasmPath);
  console.log(`  ✓ built ${bytes.length} bytes, sha256 ${sha256Hex(bytes)}`);
  if (!bytes.includes(Buffer.from('outlayer.manifest')))
    throw new Error('The outlayer.manifest section is missing: the keystore would issue no keys');
}

const wasmUrl = (sha: string) => `${FASTFS_HOST}/${caller.accountId}/${CONTRACT}/${sha}.wasm`;

/** FastFS `Simple` record, Borsh: variant 0, path, Some(mime, bytes). */
function fastfsPayload(path: string, mime: string, content: Uint8Array): Uint8Array {
  const str = (s: string) => {
    const b = utf8ToBytes(s);
    return Buffer.concat([u32(b.length), b]);
  };
  const u32 = (n: number) => {
    const b = Buffer.alloc(4);
    b.writeUInt32LE(n);
    return b;
  };
  return Buffer.concat([
    Buffer.from([0]),
    str(path),
    Buffer.from([1]),
    str(mime),
    u32(content.length),
    content,
  ]);
}

async function upload() {
  const bytes = new Uint8Array(readFileSync(wasmPath));
  if (bytes.length > 1 << 20) throw new Error('Over 1 MiB: FastFS would need chunks');
  const sha = sha256Hex(bytes);
  const url = wasmUrl(sha);
  if ((await fetchHash(url)) === sha) return console.log(`  ✓ already served at ${url}`);
  await keepBalance(NEAR / 100n);
  // Gas is 1 Ggas on purpose: no code runs; the FastFS indexer reads the transaction's arguments.
  const out = await near.send(caller, CONTRACT, [
    actions.functionCall(
      '__fastdata_fastfs',
      fastfsPayload(`${sha}.wasm`, 'application/wasm', bytes),
      1_000_000_000n,
      0n,
    ),
  ]);
  note('fastfs upload', out.txHash);
  for (let i = 0; i < 40; i++) {
    if ((await fetchHash(url)) === sha) return console.log(`  ✓ served at ${url}`);
    await new Promise((r) => setTimeout(r, 5_000));
  }
  throw new Error(`FastFS does not serve ${url} yet`);
}

async function fetchHash(url: string): Promise<string | null> {
  const res = await fetch(url).catch(() => null);
  if (!res?.ok) return null;
  return sha256Hex(new Uint8Array(await res.arrayBuffer()));
}

async function prove() {
  const sha = sha256Hex(new Uint8Array(readFileSync(wasmPath)));
  const wasm = { url: wasmUrl(sha), sha256: sha };
  const client = new OutLayerClient(
    () => near.account(caller.accountId, env('RELAYER_PRIVATE_KEY') as KeyPairString),
    CONTRACT,
  );
  type Proof = { json: string; signature: string; enclave_key: string };
  // `--tx <hash>` re-checks a run already paid for instead of starting another.
  const earlier = process.argv[process.argv.indexOf('--tx') + 1];
  let run: RunResult<Proof>;
  if (process.argv.includes('--tx') && earlier) {
    run = await client.outcome<Proof>(earlier, JSON.stringify({ op: 'key_proof' }));
  } else {
    await keepBalance(NEAR / 50n);
    run = await client.run<Proof>({ wasm }, { op: 'key_proof' });
    note('key proof run', run.txHash);
  }
  const proof = JSON.parse(run.result.json) as {
    type: string;
    signing_key: string;
    encryption_key_hex: string;
    quote_signer_key: string;
    caller: string;
  };
  const signatureOk = ed25519.verify(
    fromBase64(run.result.signature),
    utf8ToBytes(KEY_PROOF_DOMAIN + run.result.json),
    parseNearKey(proof.signing_key).bytes,
  );
  const att = await checkAttestation(
    (contract, method, args) => near.view(contract, method, args),
    { api: API, workerRegistry: WORKER_REGISTRY, caller: caller.accountId, wasm },
    run,
  );
  const checks = [
    { rule: 'Key proof signed by the key it names', ok: signatureOk },
    { rule: 'Key proof names our caller', ok: proof.caller === caller.accountId },
    { rule: 'Quote key is the registry’s', ok: proof.quote_signer_key === testnet.quote_signer },
    ...att.checks,
  ];
  for (const c of checks) console.log(`  ${c.ok ? '✓' : '✗'} ${c.rule}`);
  console.log(`  attestation ${att.url}`);
  if (!checks.every((c) => c.ok)) throw new Error('The key proof did not check out');
  // The build being replaced stays listed: receipts its key signed still need its evidence.
  const prior = existsSync(recordPath)
    ? OutLayerDeployment.parse(JSON.parse(readFileSync(recordPath, 'utf8')))
    : null;
  const built = {
    wasm,
    signingKey: proof.signing_key,
    encryptionKeyHex: proof.encryption_key_hex,
    keyProof: { txHash: run.txHash, json: run.result.json, signature: run.result.signature },
    attestation: { url: att.url, measurements: att.measurements, quoteHash: att.quoteHash },
    registerTx: null,
  };
  if (backup) {
    if (!prior) throw new Error('Publish the main build first');
    // One backup per main build: it must run the same code, so a new one replaces the old.
    const record = OutLayerDeployment.parse({ ...prior, backups: [built] });
    writeFileSync(recordPath, `${JSON.stringify(record, null, 2)}\n`);
    return console.log(`  ✓ wrote the backup build to ${recordPath}`);
  }
  const previous = !prior
    ? []
    : prior.signingKey === proof.signing_key
      ? prior.previous
      : [
          {
            wasm: prior.wasm,
            signingKey: prior.signingKey,
            encryptionKeyHex: prior.encryptionKeyHex,
            keyProof: prior.keyProof,
            attestation: prior.attestation,
            registerTx: prior.registerTx,
          },
          ...prior.previous,
        ];
  const record = OutLayerDeployment.parse({
    network: 'testnet',
    contract: CONTRACT,
    api: API,
    workerRegistry: WORKER_REGISTRY,
    caller: caller.accountId,
    wasm,
    signingKey: proof.signing_key,
    encryptionKeyHex: proof.encryption_key_hex,
    quoteSignerKey: proof.quote_signer_key,
    keyProof: { txHash: run.txHash, json: run.result.json, signature: run.result.signature },
    attestation: { url: att.url, measurements: att.measurements, quoteHash: att.quoteHash },
    registerTx: null,
    previous,
    // A backup runs the code of the build it stands in for: a new main build starts with none.
    backups: [],
  });
  writeFileSync(recordPath, `${JSON.stringify(record, null, 2)}\n`);
  console.log(`  ✓ wrote ${recordPath}`);
}

async function register() {
  if (!existsSync(recordPath)) throw new Error('Run prove first');
  const record = OutLayerDeployment.parse(JSON.parse(readFileSync(recordPath, 'utf8')));
  const target = backup ? record.backups[0] : record;
  if (!target) throw new Error('No backup build: run prove --backup first');
  if (target.registerTx) return console.log(`  ✓ already registered (tx ${target.registerTx})`);
  if (env('DEPLOY_ACCOUNT_ID') !== testnet.governance)
    throw new Error('DEPLOY_ACCOUNT_ID is not the registry governance');
  await keepBalance(REGISTER_DEPOSIT + NEAR / 100n);
  const governance = near.account(testnet.governance, env('DEPLOY_PRIVATE_KEY') as KeyPairString);
  const out = await near.call(
    governance,
    testnet.registry,
    'register_enclave',
    {
      public_key: target.signingKey,
      measurements: target.attestation.measurements,
      quote_hash: target.attestation.quoteHash,
    },
    { deposit: REGISTER_DEPOSIT },
  );
  if (!out.ok) throw new Error(`register_enclave failed: ${out.error}`);
  note('register_enclave', out.txHash);
  target.registerTx = out.txHash;
  writeFileSync(recordPath, `${JSON.stringify(record, null, 2)}\n`);
}

const steps: Record<string, () => unknown> = { build, upload, prove, register };
const step = process.argv[2] ?? '';
const run = steps[step];
if (!run) {
  console.error(`Usage: pnpm outlayer:enclave ${Object.keys(steps).join('|')}`);
  process.exit(1);
}
Promise.resolve(run()).catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
