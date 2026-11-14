import { readFileSync } from 'node:fs';
import type { Db } from '@glidepath/db';
import type { EnclaveIdentity } from '@glidepath/enclave';
import { actions, KeyPair, type KeyPairString, type NearClient } from '@glidepath/near';
import { simulatorPublicKey } from '@glidepath/oneclick';
import { updateSimSettings } from '../sim-settings.ts';
import { LOCAL_MIN_COOLING_OFF_MS, SANDBOX_MS_PER_BLOCK, type WorldConfig } from '../world.ts';

/**
 * The blind trust prototype's piece of a world: its contract and the tokens a trust can hold. On
 * the local world the tokens are demo tokens (labelled simulated where shown) priced on the
 * simulated market; the 1Click simulator can mint them to pay out swaps.
 */
export interface TrustToken {
  symbol: string;
  name: string;
  /** The mandate's sector tag for this token. */
  sector: string;
  account: string;
  decimals: number;
  /** Listing price on the simulated market, USD × 10^6. */
  basePriceE6: string;
}

export interface TrustWorld {
  contract: string;
  tokens: TrustToken[];
}

const NEAR = 10n ** 24n;

/** The demo's assets: a broad index, bonds, gold, and two sectors an official might regulate. */
const DEMO_TOKENS: Omit<TrustToken, 'account'>[] = [
  {
    symbol: 'IDX',
    name: 'Broad market index',
    sector: 'broad',
    decimals: 18,
    basePriceE6: '25000000',
  },
  {
    symbol: 'BOND',
    name: 'Treasury bond fund',
    sector: 'bonds',
    decimals: 18,
    basePriceE6: '100000000',
  },
  { symbol: 'GOLD', name: 'Gold', sector: 'commodities', decimals: 18, basePriceE6: '40000000' },
  { symbol: 'NRG', name: 'Energy sector', sector: 'energy', decimals: 18, basePriceE6: '75000000' },
  { symbol: 'DEFI', name: 'DeFi sector', sector: 'defi', decimals: 18, basePriceE6: '12000000' },
];

const wasm = (name: string) =>
  new Uint8Array(readFileSync(new URL(`../../../../contracts/res/${name}.wasm`, import.meta.url)));

/**
 * Deploys the trust contract on a local world: the plan account code (already published by the
 * registry) for trust accounts, the simulated enclave and the 1Click simulator's key on its
 * allowlists, and its own key deleted. Then the demo tokens, owned by the simulator's solver.
 */
export async function bootstrapTrustWorld(
  near: NearClient,
  w: WorldConfig,
  identity: EnclaveIdentity,
): Promise<TrustWorld> {
  const root = near.account(w.root, w.keys[w.root] as KeyPairString);
  const governance = near.account(w.governance, w.keys[w.governance] as KeyPairString);
  const must = async (label: string, p: Promise<{ ok: boolean; error?: string }>) => {
    const out = await p;
    if (!out.ok) throw new Error(`Trust bootstrap failed (${label}): ${out.error}`);
  };
  const contract = `blind-trust.${w.root}`;
  const key = KeyPair.fromRandom('ed25519');
  await must(
    'create contract',
    near.send(root, contract, [
      actions.createAccount(),
      actions.transfer(30n * NEAR),
      actions.addFullAccessKey(key.getPublicKey()),
      actions.deployContract(wasm('blind_trust')),
    ]),
  );
  const self = near.account(contract, key.toString() as KeyPairString);
  await must(
    'init',
    near.call(self, contract, 'new', {
      governance: w.governance,
      min_cooling_off_ms: LOCAL_MIN_COOLING_OFF_MS,
      enclave_activation_delay_ms: LOCAL_MIN_COOLING_OFF_MS,
      account_code_hash: w.registryCodeHash,
    }),
  );
  await must(
    'register enclave',
    near.call(
      governance,
      contract,
      'register_enclave',
      {
        public_key: identity.signingKey,
        measurements: identity.quote.measurements,
        quote_hash: identity.quoteHash,
      },
      { deposit: NEAR / 10n },
    ),
  );
  await must(
    'quote signer',
    near.call(governance, contract, 'set_quote_signer', {
      public_key: simulatorPublicKey(Buffer.from(w.oneclickSecretHex, 'hex')),
    }),
  );
  await must(
    'delete contract key',
    near.send(self, contract, [actions.deleteKey(key.getPublicKey())]),
  );

  const tokens: TrustToken[] = [];
  for (const t of DEMO_TOKENS) {
    const account = `labs-${t.symbol.toLowerCase()}.${w.root}`;
    const tokenKey = KeyPair.fromRandom('ed25519');
    await must(
      `token ${t.symbol}`,
      near.send(root, account, [
        actions.createAccount(),
        actions.transfer(5n * NEAR),
        actions.addFullAccessKey(tokenKey.getPublicKey()),
        actions.deployContract(wasm('demo_token')),
      ]),
    );
    await must(
      `init ${t.symbol}`,
      near.call(near.account(account, tokenKey.toString() as KeyPairString), account, 'new', {
        owner_id: w.solver,
        metadata: { spec: 'ft-1.0.0', name: t.name, symbol: t.symbol, decimals: t.decimals },
        allocations: [],
      }),
    );
    tokens.push({ ...t, account });
  }
  // The enclave and the quote key wait out the activation delay; the local chain skips past it.
  await near.fastForward(Math.ceil(LOCAL_MIN_COOLING_OFF_MS / SANDBOX_MS_PER_BLOCK) + 100, {
    settle: false,
  });
  return { contract, tokens };
}

/** Lists the trust tokens on the simulated market (after `saveWorld`, which resets it). */
export async function seedTrustMarket(db: Db, trust: TrustWorld): Promise<void> {
  await updateSimSettings(db, (s) => {
    for (const t of trust.tokens)
      s.market.assets[t.account.toLowerCase()] ??= { basePriceE6: t.basePriceE6 };
  });
}

/** The 1Click asset id of a trust token. */
export const trustAssetId = (account: string) => `nep141:${account}`;

/**
 * The trust contract on testnet, from `pnpm trust:deploy` (deployments/trust-testnet.json), or
 * null where it was not deployed: the Labs page then says so.
 */
export function loadTrustDeployment(deploymentsDir: string): TrustWorld | null {
  try {
    const record = JSON.parse(readFileSync(`${deploymentsDir}/trust-testnet.json`, 'utf8')) as {
      contract: string;
      tokens: TrustToken[];
    };
    return { contract: record.contract, tokens: record.tokens };
  } catch {
    return null;
  }
}
