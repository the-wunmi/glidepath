import { createServer } from 'node:net';
import { ed25519 } from '@noble/curves/ed25519.js';
import { formatNearKey, oneclickQuoteMessage, sealTo, signingBytes, toBase64 } from '@vsp/core';
import { createDb, createPool, dailyUsage, trustTrades } from '@vsp/db';
import { runMigrations } from '@vsp/db/migrate';
import { deriveEnclaveKeys } from '@vsp/enclave';
import { type KeyPairString, NearClient } from '@vsp/near';
import {
  type ChainTrust,
  mandateCommitment,
  newTrustSalt,
  parseMandate,
  sealedMandateJson,
  TRUST_TRADE_DOMAIN,
  type TradeRequest,
  type TrustEnvelope,
  verifyTrustReceipt,
} from '@vsp/trust';
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  bootstrapLocalWorld,
  bootstrapTrustWorld,
  type Engine,
  enclaveHardwareSecret,
  identityOnlyEnclave,
  loadConfig,
  ModuleTrustEnclave,
  saveWorld,
  seedTrustMarket,
  startLocalChains,
  tickTrusts,
  trustsOf,
  useTrustEnclave,
} from '../src/index.ts';
import { createTrust } from '../src/trusts/service.ts';
import { attachEngine, testEnv, type World } from './harness.ts';
import { buildLocalModule, type LocalRun, localBuild, localClient } from './local-enclave.ts';

/**
 * The blind trust prototype on real Postgres and a local NEAR sandbox: the official creates and
 * funds a trust, the enclave rebalances it through the 1Click simulator, every receipt verifies,
 * and neither a compromised enclave nor the official can take assets out of its rules.
 */

const DAY = 86_400_000;
const NEAR = 10n ** 24n;
const MODULE_SEED = '33'.repeat(32);

async function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const server = createServer();
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as { port: number }).port;
      server.close(() => resolve(port));
    });
  });
}

let world: World;
let e: Engine;
let stopChains: () => Promise<void>;

beforeAll(async () => {
  const ports = { api: await freePort(), near: await freePort(), evm: await freePort() };
  const config = loadConfig({ ...process.env, ...testEnv(ports) });
  await runMigrations(config.DATABASE_URL);
  const pool = createPool(config.DATABASE_URL);
  const db = createDb(pool);
  const chains = await startLocalChains(config);
  stopChains = chains.stop;
  const near = new NearClient(chains.near.rpcUrl);
  const enclave = identityOnlyEnclave(config, db);
  const w = await bootstrapLocalWorld(chains, enclave, config.EVM_CHAIN_ID);
  w.trust = await bootstrapTrustWorld(near, w, await enclave.identity());
  await saveWorld(db, await near.genesisHash(), w);
  await seedTrustMarket(db, w.trust);
  await pool.end();
  world = await attachEngine(config, { clearHistory: true });
  e = world.e;
});

afterAll(async () => {
  await world?.close();
  await stopChains?.();
});

const token = (symbol: string) => {
  const t = e.world.trust?.tokens.find((x) => x.symbol === symbol);
  if (!t) throw new Error(`no ${symbol}`);
  return t;
};
const asset = (symbol: string) => `nep141:${token(symbol).account}`;

/** Broad index 60%, bonds 40%, energy excluded in the mandate and the envelope. */
async function sealedTrust(encryptionKeyHex: string, label: string) {
  const now = await e.near.chainTimeMs();
  const end = new Date(now + 180 * DAY).toISOString();
  const mandate = parseMandate({
    version: 1,
    universe: [
      { asset: asset('IDX'), sector: 'broad' },
      { asset: asset('BOND'), sector: 'bonds' },
      { asset: asset('NRG'), sector: 'energy' },
    ],
    excluded_sectors: ['energy'],
    targets: [
      { asset: asset('IDX'), weight_bps: 6_000 },
      { asset: asset('BOND'), weight_bps: 4_000 },
    ],
    band_bps: 500,
    max_trade_usd: '2000',
    min_trade_usd: '10',
    beneficiary: e.world.founder,
    end,
  });
  const envelope: TrustEnvelope = {
    excluded_assets: [asset('NRG')],
    period_ms: DAY,
    max_turnover_usd_e6: (5_000n * 1_000_000n).toString(),
    min_gap_ms: 60_000,
  };
  const salt = newTrustSalt();
  const created = await createTrust(e, {
    label,
    commitment: mandateCommitment(mandate, salt),
    sealed_box: sealTo(encryptionKeyHex, sealedMandateJson(mandate, salt)),
    envelope,
    cooling_off_ms: 600_000,
    end_ms: Date.parse(end),
    deposits: [{ asset: asset('IDX'), tokens: '400' }],
  });
  const trust = await until('trust active', async () => {
    const t = await trustsOf(e).trust(created.trustId);
    return t?.status === 'active' ? t : null;
  });
  return { ...created, trust };
}

/** One turn of the outside world for a trust: it wakes, 1Click moves on, workflows follow. */
async function until<T>(
  label: string,
  fn: () => Promise<T | null | undefined | false>,
  ids?: number[],
) {
  for (let i = 0; i < 60; i++) {
    const v = await fn();
    if (v) return v;
    if (ids) await tickTrusts(e, ids);
    await e.oneclickSim?.advance();
    await new Promise((r) => setTimeout(r, 1_000));
  }
  throw new Error(`Timed out: ${label}`);
}

async function trade(trustId: number, seq: number) {
  const [row] = await e.db
    .select()
    .from(trustTrades)
    .where(and(eq(trustTrades.trustId, trustId), eq(trustTrades.seq, seq)));
  return row ?? null;
}

const balance = async (symbol: string, account: string) =>
  BigInt(
    await e.near
      .view<string>(token(symbol).account, 'ft_balance_of', { account_id: account })
      .catch(() => '0'),
  );

describe('blind trust', () => {
  it('a rebalance trade executes, settles and verifies in the browser checks', async () => {
    const identity = await e.enclave.identity();
    const { trustId, trust } = await sealedTrust(identity.encryptionKeyHex, 'Simulated enclave');
    expect(await e.near.accessKeyCount(trust.trust_account)).toBe(0);
    expect(await balance('IDX', trust.trust_account)).toBe(400n * 10n ** 18n);

    const settled = await until(
      'trade settled',
      async () => ((await trade(trustId, 0))?.status === 'settled' ? true : null),
      [trustId],
    );
    expect(settled).toBe(true);
    // Proceeds stay in the trust: it now holds bonds, and the index it sold is gone from it.
    expect(await balance('BOND', trust.trust_account)).toBeGreaterThan(0n);
    expect(await balance('IDX', trust.trust_account)).toBeLessThan(400n * 10n ** 18n);

    const reader = trustsOf(e);
    const [receipt] = await reader.receipts(trustId);
    const chain = (await reader.trust(trustId)) as ChainTrust;
    if (!receipt) throw new Error('no receipt');
    const verdict = verifyTrustReceipt(
      receipt,
      chain,
      await reader.enclaves(),
      { quote: identity.quote, encryptionKeyHex: identity.encryptionKeyHex },
      await reader.quoteSigners(),
    );
    expect(verdict.checks.filter((c) => c.status !== 'pass')).toEqual([]);
    expect(verdict.ok && verdict.complete).toBe(true);
  });

  it('a trade into an excluded asset is refused on-chain, even when the enclave signs it', async () => {
    const identity = await e.enclave.identity();
    const { trustId, trust } = await sealedTrust(identity.encryptionKeyHex, 'Excluded asset');
    // A genuine 1Click quote into the excluded energy token, paying the trust itself.
    const quote = await e.oneclick.quote({
      dry: false,
      swapType: 'EXACT_INPUT',
      slippageTolerance: 100,
      originAsset: asset('IDX'),
      depositType: 'ORIGIN_CHAIN',
      destinationAsset: asset('NRG'),
      amount: (10n * 10n ** 18n).toString(),
      refundTo: trust.trust_account,
      refundType: 'ORIGIN_CHAIN',
      recipient: trust.trust_account,
      recipientType: 'DESTINATION_CHAIN',
      deadline: new Date(Date.now() + 600_000).toISOString(),
    });
    // Played as a fully compromised enclave: the registered key signs whatever it is told.
    const keys = deriveEnclaveKeys(enclaveHardwareSecret(e.config.DATA_DIR));
    const now = await e.near.chainTimeMs();
    const request: TradeRequest = {
      trust_id: trustId,
      seq: trust.next_seq,
      commitment: trust.commitment,
      origin_token: token('IDX').account,
      amount: (10n * 10n ** 18n).toString(),
      settlement: {
        venue: '1click',
        correlation_id: quote.correlationId,
        deposit_address: quote.quote.depositAddress ?? '',
        quote: { payload: oneclickQuoteMessage(quote), signature: quote.signature },
      },
      attestation: { within_mandate: true, not_excluded: true, within_turnover: true },
      issued_at_ms: now,
      expires_at_ms: now + 300_000,
    };
    const json = JSON.stringify(request);
    const relayer = e.near.account(e.world.relayer, e.world.keys[e.world.relayer] as KeyPairString);
    const out = await e.near.call(
      relayer,
      e.world.trust?.contract ?? '',
      'trade',
      {
        trust_id: trustId,
        request_json: json,
        signature: toBase64(ed25519.sign(signingBytes(TRUST_TRADE_DOMAIN, json), keys.signing)),
        enclave_key: formatNearKey('ed25519', ed25519.getPublicKey(keys.signing)),
      },
      { gasTera: 300, deposit: NEAR / 10n },
    );
    expect(out.ok).toBe(false);
    expect(out.ok ? '' : out.code).toBe('excluded_asset');
    expect(await balance('IDX', trust.trust_account)).toBe(400n * 10n ** 18n);
  });

  it('the official cannot withdraw or move the assets', async () => {
    const identity = await e.enclave.identity();
    const { trustId, trust } = await sealedTrust(identity.encryptionKeyHex, 'No withdrawals');
    const official = e.near.account(
      e.world.founder,
      e.world.keys[e.world.founder] as KeyPairString,
    );
    const contract = e.world.trust?.contract ?? '';
    const direct = await e.near.call(
      official,
      trust.trust_account,
      'send',
      {
        token: token('IDX').account,
        receiver_id: e.world.founder,
        amount: '1',
        memo: null,
        register_receiver: false,
      },
      { deposit: 1n },
    );
    expect(direct.ok ? '' : direct.code).toBe('only_registry');
    const release = await e.near.call(official, contract, 'release', {
      trust_id: trustId,
      token: token('IDX').account,
    });
    expect(release.ok ? '' : release.code).toBe('not_ended');
    const finalize = await e.near.call(official, contract, 'finalize', { trust_id: trustId });
    expect(finalize.ok ? '' : finalize.code).toBe('not_ended');
    expect(await e.near.accessKeyCount(trust.trust_account)).toBe(0);
    expect(await balance('IDX', trust.trust_account)).toBe(400n * 10n ** 18n);
  });

  it('a trust may not trade more often than once a minute', async () => {
    const identity = await e.enclave.identity();
    const now = await e.near.chainTimeMs();
    await expect(
      createTrust(e, {
        label: 'Too fast',
        commitment: '11'.repeat(32),
        sealed_box: sealTo(identity.encryptionKeyHex, '{}'),
        envelope: {
          excluded_assets: [],
          period_ms: DAY,
          max_turnover_usd_e6: '1000000000',
          min_gap_ms: 59_999,
        },
        cooling_off_ms: 600_000,
        end_ms: now + 30 * DAY,
        deposits: [{ asset: asset('IDX'), tokens: '1' }],
      }),
    ).rejects.toMatchObject({ code: 'invalid' });
  });

  it('every trade counts against the relayer’s daily budget, and none goes out once it is spent', async () => {
    const identity = await e.enclave.identity();
    const { trustId } = await sealedTrust(identity.encryptionKeyHex, 'Budget');
    const today = sql`(now() at time zone 'utc')::date`;
    const used = async () =>
      (
        await e.db
          .select({ used: dailyUsage.used })
          .from(dailyUsage)
          .where(and(eq(dailyUsage.day, today), eq(dailyUsage.kind, 'relayer_write')))
      )[0]?.used ?? 0;
    const max = e.config.MAX_RELAYER_WRITES_PER_DAY;
    const before = await used();
    await e.db
      .update(dailyUsage)
      .set({ used: max })
      .where(and(eq(dailyUsage.day, today), eq(dailyUsage.kind, 'relayer_write')));
    expect(await tickTrusts(e, [trustId])).toEqual([
      { trustId, outcome: 'idle', reason: 'rate_limited' },
    ]);
    expect(await trade(trustId, 0)).toBeNull();
    await e.db
      .update(dailyUsage)
      .set({ used: before })
      .where(and(eq(dailyUsage.day, today), eq(dailyUsage.kind, 'relayer_write')));
    expect(await tickTrusts(e, [trustId])).toEqual([{ trustId, outcome: 'traded', seq: 0 }]);
    expect(await used()).toBe(before + 1);
  });

  it('the enclave-wasi module rebalances a trust the same way', async () => {
    buildLocalModule();
    const quoteKey = formatNearKey(
      'ed25519',
      ed25519.getPublicKey(Buffer.from(e.world.oneclickSecretHex, 'hex')),
    );
    const build = localBuild(MODULE_SEED, quoteKey);
    // The module's key goes on the allowlist before its trust exists, and waits out the delay.
    const governance = e.near.account(
      e.world.governance,
      e.world.keys[e.world.governance] as KeyPairString,
    );
    const registered = await e.near.call(
      governance,
      e.world.trust?.contract ?? '',
      'register_enclave',
      {
        public_key: build.signingKey,
        measurements: {
          mrtd: '11'.repeat(48),
          rtmr0: '00'.repeat(48),
          rtmr1: '00'.repeat(48),
          rtmr2: '00'.repeat(48),
          rtmr3: '00'.repeat(48),
        },
        quote_hash: '22'.repeat(32),
      },
      { deposit: NEAR / 10n },
    );
    expect(registered.ok).toBe(true);
    await e.near.fastForward(2_200);
    const runs: LocalRun[] = [];
    useTrustEnclave(e, new ModuleTrustEnclave(e, localClient(runs, quoteKey), build));

    const { trustId, trust } = await sealedTrust(build.encryptionKeyHex, 'Enclave module');
    expect(trust.acked_by).toBe(build.signingKey);
    await until(
      'module trade settled',
      async () => ((await trade(trustId, 0))?.status === 'settled' ? true : null),
      [trustId],
    );
    expect(runs.map((r) => r.input.op)).toEqual(
      expect.arrayContaining(['trust_accept', 'trust_tick', 'trust_trade']),
    );
    const reader = trustsOf(e);
    const [receipt] = await reader.receipts(trustId);
    if (!receipt) throw new Error('no receipt');
    const verdict = verifyTrustReceipt(
      receipt,
      (await reader.trust(trustId)) as ChainTrust,
      await reader.enclaves(),
      null,
      await reader.quoteSigners(),
    );
    // A local module has no TDX quote to serve; every other check passes on chain data alone.
    expect(verdict.checks.filter((c) => c.status !== 'pass').map((c) => c.id)).toEqual([
      'attestation',
    ]);
  });
});
