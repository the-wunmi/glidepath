import { readFileSync } from 'node:fs';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import { bech32m } from '@scure/base';
import { derivationTweak, deriveSecretKey, signPayload } from '@vsp/chainsig';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  assembleSpend,
  bip143Sighash,
  DUST_SATS,
  estimatedVsize,
  hash160,
  MempoolClient,
  p2wpkhAddress,
  planClawback,
  planWithdrawal,
  type SpendView,
  scriptForAddress,
  serializeUnsigned,
  spendSighashes,
  spendTx,
  type Tx,
  txid,
  vaultAddress,
  vaultPublicKey,
  verifyDer,
} from '../src/index.ts';

interface VectorTx {
  version: number;
  locktime: number;
  inputs: { txid: string; vout: number; amount: string; sequence: number }[];
  outputs: { value: string; script: string }[];
}

const vectors = JSON.parse(
  readFileSync(new URL('../../../contracts/res/btc-vault-vectors.json', import.meta.url), 'utf8'),
) as {
  bip143_native_p2wpkh: {
    tx: VectorTx;
    unsigned_tx: string;
    input_index: number;
    pubkey_hash: string;
    public_key: string;
    sighash: string;
    signature: string;
  };
  addresses: { address: string; script: string | null }[];
  vault_spend: {
    public_key: string;
    pubkey_hash: string;
    address: string;
    spend: Pick<SpendView, 'destination' | 'amount' | 'change' | 'fee'> & {
      inputs: { txid: string; vout: number; amount: string }[];
    };
    unsigned_tx: string;
    sighashes: string[];
    estimated_vsize: number;
  };
};

const toTx = (v: VectorTx): Tx => ({
  version: v.version,
  locktime: v.locktime,
  inputs: v.inputs.map((i) => ({ ...i, amount: BigInt(i.amount) })),
  outputs: v.outputs.map((o) => ({ value: BigInt(o.value), script: hexToBytes(o.script) })),
});

describe('BIP143', () => {
  const v = vectors.bip143_native_p2wpkh;

  it('reproduces the native P2WPKH example from BIP143 byte for byte', () => {
    const tx = toTx(v.tx);
    expect(bytesToHex(serializeUnsigned(tx))).toBe(v.unsigned_tx);
    expect(bytesToHex(hash160(hexToBytes(v.public_key)))).toBe(v.pubkey_hash);
    expect(bytesToHex(bip143Sighash(tx, v.input_index, hexToBytes(v.pubkey_hash)))).toBe(v.sighash);
  });

  it('accepts the signature published in BIP143 and refuses it for another hash', () => {
    const signature = hexToBytes(v.signature);
    const key = hexToBytes(v.public_key);
    expect(verifyDer(signature, hexToBytes(v.sighash), key)).toBe(true);
    const other = hexToBytes(v.sighash);
    other[0] = (other[0] ?? 0) ^ 1;
    expect(verifyDer(signature, other, key)).toBe(false);
  });
});

describe('addresses', () => {
  it('decodes the BIP173, BIP350 and base58 testnet vectors to their scripts', () => {
    for (const { address, script } of vectors.addresses) {
      const out = scriptForAddress(address);
      expect(out ? bytesToHex(out) : null, address).toBe(script);
    }
  });

  it('refuses witness versions anyone could spend today', () => {
    const address = (version: number, program: Uint8Array) =>
      bech32m.encode('tb', [version, ...bech32m.toWords(program)]);
    expect(scriptForAddress(address(2, new Uint8Array(32).fill(1)))).toBeNull();
    expect(scriptForAddress(address(16, new Uint8Array(2).fill(1)))).toBeNull();
    expect(scriptForAddress(address(1, new Uint8Array(20).fill(1)))).toBeNull();
    expect(scriptForAddress(address(1, new Uint8Array(32).fill(1)))).not.toBeNull();
  });

  it('refuses mixed case, mainnet and a v1 program under the v0 checksum', () => {
    for (const bad of [
      'tb1Qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx',
      'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4',
      '1BgGZ9tcN4rm9KBzDn7KprQz87SZ26SAMH',
      'tb1pw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx',
      '',
    ])
      expect(scriptForAddress(bad), bad).toBeNull();
  });

  it('derives a vault address the same way the contract does, from the MPC root key', () => {
    const v = vectors.vault_spend;
    expect(p2wpkhAddress(hexToBytes(v.public_key))).toBe(v.address);
    const root = secp256k1.getPublicKey(hexToBytes('07'.repeat(32)), false);
    const compressed = vaultPublicKey(`0x${bytesToHex(root)}`, 'vault.testnet', 'savings');
    const tweak = derivationTweak('vault.testnet', 'savings');
    const expected = secp256k1.getPublicKey(deriveSecretKey('07'.repeat(32), tweak), true);
    expect(bytesToHex(compressed)).toBe(bytesToHex(expected));
    expect(vaultAddress(`0x${bytesToHex(root)}`, 'vault.testnet', 'savings')).toBe(
      p2wpkhAddress(expected),
    );
  });
});

describe('vault spends', () => {
  const v = vectors.vault_spend;
  const publicKey = hexToBytes(v.public_key);
  const withSignatures = (
    spend: typeof v.spend,
    signatures: (SpendView['inputs'][0]['signature'] | null)[],
  ): SpendView => ({
    vault_id: 1,
    id: 1,
    kind: 'withdrawal',
    status: 'signed',
    requested_by: 'owner.testnet',
    requested_at_ms: 0,
    effective_at_ms: 0,
    ...spend,
    inputs: spend.inputs.map((i, k) => ({ ...i, signature: signatures[k] ?? null })),
    vetoed_by: null,
    sign_rounds: 1,
    signed_at_ms: 0,
    unsigned_tx: v.unsigned_tx,
    sighashes: v.sighashes,
  });

  it('builds the shared vault vector that the contract also checks', () => {
    const tx = spendTx(
      { ...v.spend, inputs: v.spend.inputs.map((i) => ({ ...i, signature: null })) },
      publicKey,
    );
    expect(bytesToHex(serializeUnsigned(tx))).toBe(v.unsigned_tx);
    expect(spendSighashes(tx, publicKey)).toEqual(v.sighashes);
    expect(Number(estimatedVsize(tx.inputs.length, tx.outputs))).toBe(v.estimated_vsize);
  });

  // The vector's key is the secret 1 (0279be…1798), so the test can sign as the MPC network would.
  const secret = hexToBytes(`${'00'.repeat(31)}01`);
  /** The signer's response, stored by the contract as plain hex fields. */
  const stored = (r: ReturnType<typeof signPayload>) => ({
    big_r: r.big_r.affine_point,
    s: r.s.scalar,
    recovery_id: r.recovery_id,
  });
  const mpcSign = (sighash: string) => stored(signPayload(secret, hexToBytes(sighash)));

  it('assembles a broadcastable transaction from the stored MPC signatures', () => {
    const spend = withSignatures(v.spend, v.sighashes.map(mpcSign));
    const signed = assembleSpend(spend, v.public_key);
    const tx = spendTx(spend, publicKey);
    expect(signed.txid).toBe(txid(tx));
    // version, segwit marker and flag, then the unsigned body without its version.
    expect(signed.hex.slice(0, 12)).toBe('020000000001');
    expect(signed.vsize).toBeLessThanOrEqual(v.estimated_vsize);
  });

  it('normalises a high-s signature to low s, which the network requires', () => {
    const responses = v.sighashes.map(mpcSign);
    const first = responses[0];
    if (!first) throw new Error('no signature');
    const n = secp256k1.Point.Fn.ORDER;
    const high = n - BigInt(`0x${first.s}`);
    responses[0] = { ...first, s: high.toString(16).padStart(64, '0') };
    const lowS = assembleSpend(withSignatures(v.spend, v.sighashes.map(mpcSign)), v.public_key);
    const fromHigh = assembleSpend(withSignatures(v.spend, responses), v.public_key);
    expect(fromHigh.hex).toBe(lowS.hex);
  });

  it('refuses a signature made by another key', () => {
    const other = hexToBytes(`${'00'.repeat(31)}02`);
    const responses = v.sighashes.map((h) => stored(signPayload(other, hexToBytes(h))));
    expect(() => assembleSpend(withSignatures(v.spend, responses), v.public_key)).toThrow(
      /does not verify/,
    );
  });

  it('refuses a record whose transaction differs from what its fields build', () => {
    const spend = withSignatures(v.spend, v.sighashes.map(mpcSign));
    expect(() => assembleSpend({ ...spend, amount: '150001' }, v.public_key)).toThrow(/differs/);
    expect(() =>
      assembleSpend({ ...spend, inputs: spend.inputs.slice(0, 1) }, v.public_key),
    ).toThrow(/differs/);
  });

  it('refuses to assemble before every input is signed', () => {
    const spend = withSignatures(v.spend, [mpcSign(v.sighashes[0] ?? '')]);
    expect(() => assembleSpend(spend, v.public_key)).toThrow(/not signed/);
  });
});

describe('planning a spend', () => {
  const utxos = [
    { txid: 'aa'.repeat(32), vout: 0, value: 50_000n },
    { txid: 'bb'.repeat(32), vout: 1, value: 200_000n },
  ];
  const destination = 'tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx';

  it('spends the largest UTXO first and sends change back to the vault', () => {
    const plan = planWithdrawal(utxos, destination, 100_000n, 2n, 4);
    expect(plan.inputs.map((i) => i.vout)).toEqual([1]);
    expect(plan.change + plan.fee + 100_000n).toBe(200_000n);
    expect(plan.change).toBeGreaterThanOrEqual(DUST_SATS);
  });

  it('folds change below dust into the fee instead of making a dust output', () => {
    const plan = planWithdrawal(utxos, destination, 199_500n, 1n, 4);
    expect(plan.change).toBe(0n);
    expect(plan.fee).toBe(500n);
  });

  it('refuses an amount the UTXOs cannot pay', () => {
    expect(() => planWithdrawal(utxos, destination, 260_000n, 1n, 4)).toThrow(/cannot pay/);
  });

  it('sweeps every UTXO to the recovery address in a claw-back', () => {
    const plan = planClawback(utxos, destination, 3n, 4);
    expect(plan.inputs).toHaveLength(2);
    expect(plan.change).toBe(0n);
    expect(plan.fee).toBe(
      3n * estimatedVsize(2, [{ script: scriptForAddress(destination) ?? new Uint8Array() }]),
    );
  });
});

describe('mempool.space client', () => {
  afterEach(() => vi.unstubAllGlobals());
  const respond = (body: unknown, status = 200) =>
    vi.fn(
      async () => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status }),
    );

  it('reads UTXOs and balances in satoshis as bigints', async () => {
    const fetch = respond([
      { txid: 'ab'.repeat(32), vout: 1, value: 12_345, status: { confirmed: true } },
    ]);
    vi.stubGlobal('fetch', fetch);
    const client = new MempoolClient('https://example.test/api');
    expect(await client.utxos('tb1qx')).toEqual([
      { txid: 'ab'.repeat(32), vout: 1, value: 12_345n, confirmed: true },
    ]);
    expect(fetch).toHaveBeenCalledWith(
      'https://example.test/api/address/tb1qx/utxo',
      expect.anything(),
    );
    vi.stubGlobal(
      'fetch',
      respond({
        chain_stats: { funded_txo_sum: 5000, spent_txo_sum: 1000 },
        mempool_stats: { funded_txo_sum: 0, spent_txo_sum: 700 },
      }),
    );
    expect(await client.balance('tb1qx')).toEqual({ confirmed: 4000n, unconfirmed: -700n });
  });

  it('reports a transaction it has never seen as null, and a rejected broadcast as an error', async () => {
    const client = new MempoolClient('https://example.test/api');
    vi.stubGlobal('fetch', respond('Transaction not found', 404));
    expect(await client.txStatus('ab'.repeat(32))).toBeNull();
    vi.stubGlobal(
      'fetch',
      respond('sendrawtransaction RPC error: bad-txns-inputs-missingorspent', 400),
    );
    await expect(client.broadcast('00')).rejects.toThrow(/missingorspent/);
  });

  it.runIf(process.env.BTC_LIVE === '1')('reads live testnet4 fee rates (BTC_LIVE=1)', async () => {
    const rates = await new MempoolClient().feeRates();
    expect(rates.minimumFee).toBeGreaterThan(0);
  });
});
