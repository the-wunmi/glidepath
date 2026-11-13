import { readFileSync } from 'node:fs';
import { ed25519 } from '@noble/curves/ed25519.js';
import {
  derivationTweak,
  deriveEvmAddress,
  derivePublicKey,
  erc20TransferTx,
  nearSecpKey,
  unsignedTxHash,
  unsignedTxHex,
} from '@vsp/chainsig';
import {
  formatNearKey,
  fromBase64,
  hexToBytes,
  oneclickQuoteMessage,
  oneclickSignedBytes,
  parseNearKey,
  sha256Hex,
  signingBytes,
} from '@vsp/core';
import { type Hex, keccak256 } from 'viem';
import { describe, expect, it } from 'vitest';
import { nep141ActionJson, verifyReceipt } from '../src/index.ts';

/** Vectors the Rust contracts produced from the deployed wasm (contracts/integration-tests/tests/vectors.rs). */
const vectors = JSON.parse(
  readFileSync(new URL('../../../contracts/res/test-vectors.json', import.meta.url), 'utf8'),
);

describe('the browser verifier reproduces the contracts byte for byte', () => {
  it('derives the same Chain Signatures key, tweak and address', () => {
    const v = vectors.chain_signatures_derivation;
    expect(derivationTweak(v.predecessor, v.path).toString(16).padStart(64, '0')).toBe(
      v.tweak_sha3_256,
    );
    expect(nearSecpKey(derivePublicKey(v.root_public_key, v.predecessor, v.path))).toBe(
      v.derived_public_key,
    );
    expect(deriveEvmAddress(v.root_public_key, v.predecessor, v.path)).toBe(v.evm_address);
  });

  it('builds the same unsigned EIP-1559 transfer the registry asks the MPC network to sign', () => {
    const v = vectors.eip1559_erc20_transfer;
    const tx = erc20TransferTx({
      chainId: v.chain_id,
      token: v.token_address as Hex,
      to: v.action.to as Hex,
      amount: BigInt(v.action.amount),
      nonce: v.action.nonce,
      gasLimit: BigInt(v.action.gas_limit),
      maxFeePerGas: BigInt(v.action.max_fee_per_gas),
      maxPriorityFeePerGas: BigInt(v.action.max_priority_fee_per_gas),
    });
    expect(unsignedTxHex(tx).slice(2)).toBe(v.unsigned_tx);
    expect(unsignedTxHash(tx).slice(2)).toBe(v.keccak256);
  });

  it('accepts the enclave signature the contract accepted, over the same bytes', () => {
    const v = vectors.signed_execute;
    const seed = hexToBytes(v.enclave_secret_seed_hex);
    expect(formatNearKey('ed25519', ed25519.getPublicKey(seed))).toBe(v.enclave_public_key);
    expect(
      ed25519.verify(
        fromBase64(v.signature_base64),
        signingBytes(v.domain, v.request_json),
        parseNearKey(v.enclave_public_key).bytes,
      ),
    ).toBe(true);
  });

  it('hashes the NEP-141 action exactly as the registry does', () => {
    const v = vectors.nep141_action_hash;
    const args = JSON.parse(v.ft_transfer_args);
    const json = nep141ActionJson(args.receiver_id, args.amount, 1, 0);
    expect(json).toBe(v.ft_transfer_args);
    expect(sha256Hex(json)).toBe(v.sha256);
  });
});

describe('the verifier catches a doctored receipt', () => {
  const v = vectors.signed_execute;
  const request = JSON.parse(v.request_json);
  const enclave = {
    public_key: v.enclave_public_key,
    measurements: { mrtd: '0', rtmr0: '0', rtmr1: '0', rtmr2: '0', rtmr3: '0' },
    quote_hash: '0',
    registered_at_ms: 0,
    active_from_ms: 0,
    revoked_at_ms: null,
  };
  const receipt = {
    plan_id: request.plan_id,
    seq: request.seq,
    commitment: request.commitment,
    period_index: 0,
    kind: 'sale' as const,
    amount: request.action.amount,
    receiver: request.action.receiver_id,
    action_hash: vectors.nep141_action_hash.sha256,
    request_json: v.request_json,
    signature: v.signature_base64,
    enclave_key: v.enclave_public_key,
    settlement: request.settlement,
    status: 'done' as const,
    evm_nonce: null,
    evm_gas_limit: null,
    evm_unsigned_tx: null,
    evm_signature: null,
    created_at_ms: 1,
    finished_at_ms: 2,
  };
  const facts = JSON.parse(request.settlement.quote.payload);
  const plan = {
    commitment: request.commitment,
    asset: { type: 'nep141', token_id: facts.originAsset.replace(/^nep141:/, '') },
    beneficiary: { near_account: facts.recipient, evm_address: null },
    proceeds_asset: facts.destinationAsset,
    plan_account: facts.refundTo,
  } as never;
  const quoteSigner = vectors.quote.quote_signer_public_key;
  const failing = async (r: typeof receipt) =>
    (await verifyReceipt(r, plan, [enclave], null, {}, quoteSigner)).checks
      .filter((c) => c.status === 'fail')
      .map((c) => c.id);

  it('passes the genuine contract vector, except the attestation it does not carry', async () => {
    expect(await failing(receipt)).toEqual(['attestation']);
  });

  it('binds proceeds to a quote 1Click signed for this beneficiary and amount', async () => {
    const secret = new Uint8Array(32).fill(4);
    const signer = formatNearKey('ed25519', ed25519.getPublicKey(secret));
    const facts = {
      deposit_address: request.action.receiver_id,
      amount_in: request.action.amount,
      min_amount_out: request.settlement.min_amount_out,
      recipient: 'founder.near',
    };
    // A quote in 1Click's own format, signed by a test key standing in for 1Click's.
    const signedQuote = (f: typeof facts, amountOutUsd = '15.150000000000') => {
      const payload = oneclickQuoteMessage({
        timestamp: '2026-11-11T11:40:04.596Z',
        quoteRequest: {
          dry: false,
          swapType: 'EXACT_INPUT',
          slippageTolerance: 100,
          originAsset: 'nep141:t',
          depositType: 'ORIGIN_CHAIN',
          destinationAsset: 'nep141:usdc.near',
          amount: f.amount_in,
          refundTo: 'p1.registry.near',
          refundType: 'ORIGIN_CHAIN',
          recipient: f.recipient,
          recipientType: 'DESTINATION_CHAIN',
          deadline: '2026-11-11T12:40:03.000Z',
        },
        quote: {
          amountIn: f.amount_in,
          amountInFormatted: '10',
          amountInUsd: '15.200000000000',
          minAmountIn: f.amount_in,
          amountOut: '15150000',
          amountOutFormatted: '15.15',
          amountOutUsd,
          minAmountOut: f.min_amount_out,
          depositAddress: f.deposit_address,
          deadline: '2026-11-14T12:40:03.000Z',
        },
      });
      return {
        payload,
        signature: formatNearKey('ed25519', ed25519.sign(oneclickSignedBytes(payload), secret)),
      };
    };
    const planWithAsset = {
      commitment: request.commitment,
      asset: { type: 'nep141', token_id: 't' },
      beneficiary: { near_account: 'founder.near', evm_address: null },
      proceeds_asset: 'nep141:usdc.near',
      plan_account: 'p1.registry.near',
    } as never;
    const withQuote = (q: { payload: string; signature: string }) => {
      const r = { ...request, settlement: { ...request.settlement, quote: q } };
      return { ...receipt, request_json: JSON.stringify(r) };
    };
    const quoteStatus = async (q: { payload: string; signature: string }) =>
      (await verifyReceipt(withQuote(q), planWithAsset, [enclave], null, {}, signer)).checks.find(
        (c) => c.id === 'quote',
      )?.status;
    expect(await quoteStatus(signedQuote(facts))).toBe('pass');
    expect(await quoteStatus(signedQuote({ ...facts, recipient: 'attacker.near' }))).toBe('fail');
    expect(await quoteStatus(signedQuote(facts, '13.000000000000'))).toBe('fail');
    const forged = signedQuote(facts);
    expect(
      await quoteStatus({ ...forged, payload: forged.payload.replace('founder', 'attacker') }),
    ).toBe('fail');
  });

  it('checks an old receipt against the quote key in force at the time, not today’s', async () => {
    const history = [
      { public_key: quoteSigner, active_from_ms: 0, replaced_at_ms: 100 },
      {
        public_key: 'ed25519:11111111111111111111111111111111',
        active_from_ms: 100,
        replaced_at_ms: null,
      },
    ];
    const result = await verifyReceipt(receipt, plan, [enclave], null, {}, history);
    expect(result.checks.find((c) => c.id === 'quote')?.status).toBe('pass');
  });

  it('fails when the stored request is edited', async () => {
    const edited = { ...receipt, request_json: v.request_json.replace('"seq":0', '"seq":1') };
    expect(await failing(edited)).toContain('signature');
  });

  it('fails when the receipt claims a different amount than was signed', async () => {
    expect(await failing({ ...receipt, amount: '1' })).toContain('binding');
  });

  it('fails when the action hash does not match the transfer', async () => {
    expect(await failing({ ...receipt, action_hash: '0'.repeat(64) })).toContain('action');
  });

  it('fails when the signing key was not on the allowlist at the time', async () => {
    const late = await verifyReceipt(receipt, plan, [{ ...enclave, active_from_ms: 10 }], null);
    expect(late.checks.find((c) => c.id === 'allowlist')?.status).toBe('fail');
  });
});

describe('the verifier and later events', () => {
  const v = vectors.eip1559_erc20_transfer;
  const base = {
    chainId: v.chain_id,
    token: v.token_address as Hex,
    to: v.action.to as Hex,
    amount: BigInt(v.action.amount),
    nonce: v.action.nonce,
    gasLimit: BigInt(v.action.gas_limit),
    maxFeePerGas: BigInt(v.action.max_fee_per_gas),
    maxPriorityFeePerGas: BigInt(v.action.max_priority_fee_per_gas),
  };
  const evmPlan = {
    commitment: 'c',
    asset: { type: 'evm_erc20', chain_id: v.chain_id, token_address: v.token_address },
    beneficiary: {
      near_account: 'b.near',
      evm_address: '0x000000000000000000000000000000000000beef',
    },
    proceeds_asset: 'nep141:usdc.near',
    plan_account: 'p1.r.near',
    evm_address: '0x0000000000000000000000000000000000000001',
  } as never;
  const evmReceipt = (unsigned: string) => ({
    plan_id: 1,
    seq: 0,
    commitment: 'c',
    period_index: 0,
    kind: 'sale' as const,
    amount: v.action.amount,
    receiver: v.action.to,
    action_hash: keccak256(`0x${unsigned.replace(/^0x/, '')}` as Hex).slice(2),
    request_json: JSON.stringify({
      plan_id: 1,
      seq: 0,
      commitment: 'c',
      action: v.action,
      settlement: {},
      compliance: {},
    }),
    signature: 'AA==',
    enclave_key: 'ed25519:x',
    settlement: null,
    status: 'done' as const,
    evm_nonce: v.action.nonce,
    evm_gas_limit: v.action.gas_limit,
    evm_unsigned_tx: unsigned.replace(/^0x/, ''),
    evm_signature: null,
    created_at_ms: 1,
    finished_at_ms: 2,
  });
  const actionCheck = async (unsigned: string) =>
    (await verifyReceipt(evmReceipt(unsigned), evmPlan, [], null)).checks.find(
      (c) => c.id === 'action',
    );

  it('accepts an EVM transfer re-signed with higher fees and nothing else changed', async () => {
    const bumped = unsignedTxHex(
      erc20TransferTx({ ...base, maxFeePerGas: base.maxFeePerGas * 2n }),
    );
    const c = await actionCheck(bumped);
    expect(c?.status).toBe('pass');
    expect(c?.label).toContain('re-signed with higher fees only');
  });

  it('fails a re-signed transfer that changes the recipient', async () => {
    const other = unsignedTxHex(
      erc20TransferTx({
        ...base,
        to: '0x000000000000000000000000000000000000dead',
        maxFeePerGas: base.maxFeePerGas * 2n,
      }),
    );
    expect((await actionCheck(other))?.status).toBe('fail');
  });

  it('fails a re-signed transfer that lowers the fees below what was approved', async () => {
    const lower = unsignedTxHex(
      erc20TransferTx({ ...base, maxFeePerGas: 1n, maxPriorityFeePerGas: 1n }),
    );
    expect((await actionCheck(lower))?.status).toBe('fail');
  });

  it('checks a release only pays the beneficiary', async () => {
    const release = { ...evmReceipt(v.unsigned_tx), kind: 'release' as const, request_json: null };
    const good = await verifyReceipt(
      { ...release, receiver: '0x000000000000000000000000000000000000beef' },
      evmPlan,
      [],
      null,
    );
    const bad = await verifyReceipt(
      { ...release, receiver: '0x000000000000000000000000000000000000dead' },
      evmPlan,
      [],
      null,
    );
    expect(good.ok).toBe(true);
    expect(bad.ok).toBe(false);
  });
});
