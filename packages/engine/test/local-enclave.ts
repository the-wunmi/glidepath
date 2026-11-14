import { execFileSync, spawnSync } from 'node:child_process';
import { sha256Hex } from '@vsp/core';
import {
  ModuleError,
  type OutLayerBuild,
  type OutLayerDeployment,
  type RunResult,
} from '../src/outlayer.ts';

/**
 * The OutLayer module's own code run locally: `vsp-enclave-local` runs the same operations as the
 * OutLayer build (enclave-wasi/src/enclave.rs) with keys from a seed instead of the keystore. Two
 * seeds stand in for two published builds, each with its own keys.
 */
const crate = new URL('../../../enclave-wasi/', import.meta.url).pathname;
const binary = `${crate}target/release/vsp-enclave-local`;

export function buildLocalModule(): void {
  execFileSync(
    `${process.env.HOME}/.cargo/bin/cargo`,
    ['build', '--release', '--bin', 'vsp-enclave-local'],
    { cwd: crate, stdio: 'ignore' },
  );
}

export interface LocalBuild extends OutLayerBuild {
  encryptionKeyHex: string;
}

const moduleEnv = (seed: string, quoteKey: string) => ({
  VSP_LOCAL_ENCLAVE_SEED_HEX: seed,
  VSP_QUOTE_SIGNER_KEY: quoteKey,
});

/** A build's keys as OutLayer's keystore would issue them; the seed stands in for its wasm hash. */
export function localBuild(seed: string, quoteKey: string): LocalBuild {
  const out = spawnSync(binary, { input: '{"op":"key_proof"}', env: moduleEnv(seed, quoteKey) });
  const proof = JSON.parse(JSON.parse(out.stdout.toString()).result.json) as {
    signing_key: string;
    encryption_key_hex: string;
  };
  return {
    signingKey: proof.signing_key,
    encryptionKeyHex: proof.encryption_key_hex,
    wasm: { url: `https://wasm.test/${seed.slice(0, 8)}`, sha256: seed },
  };
}

export type LocalRun = { build: string; input: Record<string, unknown> };

/** Runs the module the way OutLayer would: JSON on stdin, JSON on stdout. */
export function localClient(runs: LocalRun[], quoteKey: string) {
  return {
    async run<T>(build: Pick<OutLayerBuild, 'wasm'>, input: object): Promise<RunResult<T>> {
      const seed = build.wasm.sha256;
      runs.push({ build: seed, input: input as Record<string, unknown> });
      const inputData = JSON.stringify(input);
      const out = spawnSync(binary, { input: inputData, env: moduleEnv(seed, quoteKey) });
      const parsed = JSON.parse(out.stdout.toString()) as
        | { ok: true; result: T }
        | { ok: false; error: string };
      if (!parsed.ok) throw new ModuleError(parsed.error);
      return { txHash: 'local', inputData, outputBytes: out.stdout, result: parsed.result };
    },
  };
}

/** The measurements and quote hash a local build is registered with. */
export const localEvidence = (b: LocalBuild) => ({
  measurements: {
    mrtd: sha256Hex(`${b.signingKey}/mrtd`).repeat(2).slice(0, 96),
    rtmr0: '00'.repeat(48),
    rtmr1: '00'.repeat(48),
    rtmr2: '00'.repeat(48),
    rtmr3: '00'.repeat(48),
  },
  quoteHash: sha256Hex(b.signingKey),
});

const evidenceOf = (b: LocalBuild) => {
  const { measurements, quoteHash } = localEvidence(b);
  return {
    wasm: b.wasm,
    signingKey: b.signingKey,
    encryptionKeyHex: b.encryptionKeyHex,
    keyProof: { txHash: 'local', json: '{}', signature: '' },
    attestation: { url: 'https://outlayer.test/attestation', measurements, quoteHash },
    registerTx: null,
  };
};

/** A deployment record naming `current` and the earlier builds, as scripts/outlayer-enclave.ts writes it. */
export function localDeployment(
  quoteKey: string,
  current: LocalBuild,
  ...previous: LocalBuild[]
): OutLayerDeployment {
  return {
    network: 'testnet',
    contract: 'outlayer.test',
    api: 'https://outlayer.test',
    workerRegistry: 'worker.test',
    caller: 'relayer.test',
    quoteSignerKey: quoteKey,
    ...evidenceOf(current),
    previous: previous.map(evidenceOf),
    backups: [],
  };
}

/** A deployment whose current build has backups: each is sealed to and can stand in for it. */
export function localDeploymentWithBackups(
  quoteKey: string,
  current: LocalBuild,
  backups: LocalBuild[],
): OutLayerDeployment {
  return { ...localDeployment(quoteKey, current), backups: backups.map(evidenceOf) };
}
