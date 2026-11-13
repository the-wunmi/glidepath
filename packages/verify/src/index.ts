/**
 * Receipt verification that runs in the browser. Every check is a computation over bytes read from
 * the chain, so the server cannot fake a check by asserting it. Limits, stated plainly: the bytes
 * arrive through an RPC endpoint (the app proxies one; point it at any NEAR node you trust), NEAR
 * view results are not light-client proofs, and the TDX vendor key is simulated in this build. The
 * 1Click quote is checked in 1Click's own signature format against whichever key the registry holds.
 */

import { ed25519 } from '@noble/curves/ed25519.js';
import {
  erc20TransferTx,
  recoverSigner,
  type SignatureResponse,
  signedTx,
  unsignedTxHash,
  unsignedTxHex,
} from '@vsp/chainsig';
import {
  COMPLIANCE_LABELS,
  type Compliance,
  concatBytes,
  EXECUTE_DOMAIN,
  type ExecuteRequest,
  fromBase64,
  hexToBytes,
  meetsFloor,
  ONECLICK_LIVE_QUOTE_KEY,
  oneclickSignedBytes,
  parseNearKey,
  parseQuoteTerms,
  planLimits,
  type QuoteTerms,
  quoteCostWithinBound,
  SealedPlan,
  SimulatedQuote,
  sha256Hex,
  signingBytes,
  utf8ToBytes,
  verifySimulatedQuote,
} from '@vsp/core';
import type { ChainEnclave, ChainPlan, ChainReceipt } from '@vsp/near';
import { type Hex, keccak256, parseTransaction, type TransactionSerializableEIP1559 } from 'viem';

export type CheckStatus = 'pass' | 'fail' | 'skip';

export interface Check {
  id: string;
  label: string;
  status: CheckStatus;
  detail?: string;
}

/** One quote-signing key and when it was in force (registry `get_quote_signers`). */
export interface QuoteSignerEntry {
  public_key: string;
  active_from_ms: number;
  replaced_at_ms: number | null;
}

/** The key that was in force when the sale happened, so a later rotation does not fail old receipts. */
function signerAt(signers: string | QuoteSignerEntry[] | null, atMs: number): string | null {
  if (signers === null || typeof signers === 'string') return signers;
  const live = signers.find(
    (x) => x.active_from_ms <= atMs && (x.replaced_at_ms === null || x.replaced_at_ms > atMs),
  );
  return live?.public_key ?? null;
}

export interface ReceiptVerification {
  seq: number;
  /** No check failed. */
  ok: boolean;
  /** Every check could run (none skipped, e.g. an EVM transfer not broadcast yet). */
  complete: boolean;
  simulatedAttestation: boolean;
  checks: Check[];
}

/** Reads the verifier needs from chains, made by the caller (browser fetch to the RPC proxy). */
export interface ChainReads {
  evmTransaction?: (hash: Hex) => Promise<{ status: 'success' | 'reverted' } | null>;
}

const pass = (id: string, label: string, detail?: string): Check => ({
  id,
  label,
  status: 'pass',
  detail,
});
const fail = (id: string, label: string, detail?: string): Check => ({
  id,
  label,
  status: 'fail',
  detail,
});
const check = (id: string, label: string, ok: boolean, detail?: string): Check =>
  ok ? pass(id, label, detail) : fail(id, label, detail);

/** The JSON the registry hashes for a NEP-141 sale: ft_transfer's exact arguments. */
export const nep141ActionJson = (receiver: string, amount: string, planId: number, seq: number) =>
  JSON.stringify({ receiver_id: receiver, amount, memo: `vsp/${planId}/${seq}` });

export async function verifyReceipt(
  receipt: ChainReceipt,
  plan: ChainPlan,
  enclaves: ChainEnclave[],
  attestation: { quote: unknown; encryptionKeyHex: string } | null,
  reads: ChainReads = {},
  quoteSigner: string | QuoteSignerEntry[] | null = null,
): Promise<ReceiptVerification> {
  const checks: Check[] = [];
  if (receipt.kind === 'release') return verifyRelease(receipt, plan);
  if (!receipt.request_json || !receipt.signature || !receipt.enclave_key) {
    checks.push(
      fail(
        'signed',
        'The receipt carries an enclave-signed request',
        'This receipt has no signed request',
      ),
    );
    return { seq: receipt.seq, ok: false, complete: true, simulatedAttestation: true, checks };
  }

  // 1. The enclave's signature over the exact bytes stored on-chain.
  let sigOk = false;
  try {
    sigOk = ed25519.verify(
      fromBase64(receipt.signature),
      signingBytes(EXECUTE_DOMAIN, receipt.request_json),
      parseNearKey(receipt.enclave_key).bytes,
    );
  } catch {
    sigOk = false;
  }
  checks.push(
    check(
      'signature',
      'Enclave signature is valid over the stored request',
      sigOk,
      receipt.enclave_key,
    ),
  );

  // 2. The key was on the registry's allowlist, active and not revoked, when the sale happened.
  const enclave = enclaves.find((x) => x.public_key === receipt.enclave_key);
  const activeThen =
    !!enclave &&
    enclave.active_from_ms <= receipt.created_at_ms &&
    (enclave.revoked_at_ms === null || enclave.revoked_at_ms > receipt.created_at_ms);
  checks.push(
    check('allowlist', 'Signing key was on the on-chain enclave allowlist at the time', activeThen),
  );

  // 3. The enclave's attestation binds that key to the registered measurements.
  let simulated = true;
  if (enclave && attestation) {
    const parsed = SimulatedQuote.safeParse(attestation.quote);
    if (!parsed.success) {
      checks.push(fail('attestation', 'Attestation quote is well-formed'));
    } else {
      const result = verifySimulatedQuote(parsed.data, {
        signingKey: enclave.public_key,
        encryptionKeyHex: attestation.encryptionKeyHex,
        measurements: enclave.measurements,
        quoteHash: enclave.quote_hash,
      });
      simulated = result.simulated;
      for (const [i, c] of result.checks.entries())
        checks.push(check(`attestation-${i}`, `${c.label} (simulated TDX)`, c.ok));
    }
  } else {
    // Without the quote nothing ties the key to measured code: that is a failure, not a pass.
    checks.push(fail('attestation', 'Attestation quote available for the signing key'));
  }

  // 4. The signed request says what the receipt says.
  let request: ExecuteRequest | null = null;
  try {
    request = JSON.parse(receipt.request_json) as ExecuteRequest;
  } catch {
    request = null;
  }
  if (!request) {
    checks.push(fail('request', 'Signed request is readable'));
    return { seq: receipt.seq, ok: false, complete: true, simulatedAttestation: simulated, checks };
  }
  const receiver =
    request.action.type === 'nep141_transfer' ? request.action.receiver_id : request.action.to;
  checks.push(
    check(
      'binding',
      'Signed request matches the receipt (plan, sequence, commitment, amount, receiver)',
      request.plan_id === receipt.plan_id &&
        request.seq === receipt.seq &&
        request.commitment === receipt.commitment &&
        request.action.amount === receipt.amount &&
        receiver.toLowerCase() === receipt.receiver.toLowerCase(),
    ),
  );
  checks.push(
    check(
      'commitment',
      'Sale was made under the plan commitment',
      request.commitment === receipt.commitment,
      receipt.commitment === plan.commitment
        ? 'Current commitment'
        : 'An earlier commitment of this plan',
    ),
  );

  // 5. Each compliance answer the enclave gave (yes/no only; the plan's numbers stay sealed).
  for (const [key, label] of Object.entries(COMPLIANCE_LABELS))
    checks.push(
      check(`compliance-${key}`, label, request.compliance[key as keyof Compliance] === true),
    );

  // 6. Price and destination: bound to a quote 1Click signed, paying the beneficiary.
  checks.push(quoteCheck(request, receipt, plan, signerAt(quoteSigner, receipt.created_at_ms)));

  // 7. What the registry actually did matches what was signed.
  if (request.action.type === 'nep141_transfer') {
    const hash = sha256Hex(
      nep141ActionJson(
        request.action.receiver_id,
        request.action.amount,
        request.plan_id,
        request.seq,
      ),
    );
    checks.push(
      check(
        'action',
        'Transfer the registry made hashes to the receipt’s action hash',
        hash === receipt.action_hash,
      ),
    );
  } else if (plan.asset.type === 'evm_erc20') {
    const requested = erc20TransferTx({
      chainId: plan.asset.chain_id,
      token: plan.asset.token_address as Hex,
      to: request.action.to as Hex,
      amount: BigInt(request.action.amount),
      nonce: request.action.nonce,
      gasLimit: BigInt(request.action.gas_limit),
      maxFeePerGas: BigInt(request.action.max_fee_per_gas),
      maxPriorityFeePerGas: BigInt(request.action.max_priority_fee_per_gas),
    });
    // The receipt holds what was last signed. A re-sign (resign_evm) may raise the fees, never
    // anything else, so the signed transaction must equal the request apart from its fees.
    const stored = `0x${(receipt.evm_unsigned_tx ?? '').replace(/^0x/, '')}` as Hex;
    let tx = requested;
    let sameButFees = false;
    try {
      const parsed = parseTransaction(stored) as TransactionSerializableEIP1559;
      const withRequestFees = {
        ...parsed,
        maxFeePerGas: requested.maxFeePerGas,
        maxPriorityFeePerGas: requested.maxPriorityFeePerGas,
      };
      sameButFees =
        unsignedTxHex(withRequestFees) === unsignedTxHex(requested) &&
        (parsed.maxFeePerGas ?? 0n) >= (requested.maxFeePerGas ?? 0n);
      if (sameButFees) tx = parsed;
    } catch {
      sameButFees = false;
    }
    const hash = unsignedTxHash(tx);
    const resigned =
      sameButFees && tx !== requested && unsignedTxHex(tx) !== unsignedTxHex(requested);
    checks.push(
      check(
        'action',
        resigned
          ? 'Signed ERC-20 transfer is the requested one, re-signed with higher fees only'
          : 'ERC-20 transaction rebuilt from the request matches what the registry asked the MPC network to sign',
        sameButFees && hash.slice(2) === receipt.action_hash.replace(/^0x/, ''),
      ),
    );
    if (receipt.evm_signature && plan.evm_address) {
      const response: SignatureResponse = {
        scheme: 'Secp256k1',
        big_r: { affine_point: receipt.evm_signature.big_r },
        s: { scalar: receipt.evm_signature.s },
        recovery_id: receipt.evm_signature.recovery_id,
      };
      const signer = await recoverSigner(hash, response).catch(() => null);
      checks.push(
        check(
          'mpc',
          'Chain Signatures signature recovers to the plan’s own address',
          signer === plan.evm_address.toLowerCase(),
          signer ?? undefined,
        ),
      );
      if (reads.evmTransaction) {
        const txHash = keccak256(signedTx(tx, response));
        const onChain = await reads.evmTransaction(txHash).catch(() => null);
        checks.push(
          onChain
            ? check(
                'broadcast',
                'Signed transaction is on the EVM chain and succeeded',
                onChain.status === 'success',
                txHash,
              )
            : {
                id: 'broadcast',
                label: 'Signed transaction is on the EVM chain',
                status: 'skip',
                detail: 'Not broadcast yet',
              },
        );
      }
    } else {
      checks.push({
        id: 'mpc',
        label: 'Chain Signatures signature present',
        status: receipt.status === 'pending' ? 'skip' : 'fail',
      });
    }
  }

  // A sale still waiting on its transfer or MPC signature is not finished, not failed.
  checks.push(
    receipt.status === 'pending'
      ? {
          id: 'settled',
          label: 'Registry finished the action',
          status: 'skip',
          detail: 'In progress',
        }
      : check('settled', 'Registry finished the action', receipt.status === 'done', receipt.status),
  );
  const ok = checks.every((c) => c.status !== 'fail');
  const complete = checks.every((c) => c.status !== 'skip');
  return { seq: receipt.seq, ok, complete, simulatedAttestation: simulated, checks };
}

function quoteCheck(
  request: ExecuteRequest,
  receipt: ChainReceipt,
  plan: ChainPlan,
  quoteSigner: string | null,
): Check {
  const label =
    'Proceeds and refunds bound to a 1Click-signed quote: pays the beneficiary, refunds the plan, cost within the fee bound';
  const quote = request.settlement.quote;
  if (!quote || !quoteSigner) return fail('quote', label, 'No signed quote or no quote signer');
  // 1Click's own format: ed25519 over the text of base58(sha256(Q)); the payload is Q itself.
  let signed = false;
  try {
    signed = ed25519.verify(
      parseNearKey(quote.signature).bytes,
      oneclickSignedBytes(quote.payload),
      parseNearKey(quoteSigner).bytes,
    );
  } catch {
    signed = false;
  }
  let t: QuoteTerms | null = null;
  try {
    t = parseQuoteTerms(quote.payload);
  } catch {
    t = null;
  }
  const evm = plan.asset.type === 'evm_erc20';
  const refund = (evm ? (plan.evm_address ?? '') : (plan.plan_account ?? '')).toLowerCase();
  let costOk = false;
  try {
    costOk = !!t && quoteCostWithinBound(t);
  } catch {
    costOk = false;
  }
  const bound =
    !!t &&
    t.dry === false &&
    t.swapType === 'EXACT_INPUT' &&
    typeof t.depositAddress === 'string' &&
    t.recipient === plan.beneficiary.near_account &&
    t.depositAddress.toLowerCase() === receipt.receiver.toLowerCase() &&
    t.amountIn === receipt.amount &&
    t.amount === receipt.amount &&
    t.minAmountOut === request.settlement.min_amount_out &&
    t.destinationAsset === plan.proceeds_asset &&
    typeof t.refundTo === 'string' &&
    t.refundTo.toLowerCase() === refund &&
    (evm || plan.asset.type !== 'nep141' || t.originAsset === `nep141:${plan.asset.token_id}`);
  const who =
    quoteSigner === ONECLICK_LIVE_QUOTE_KEY ? "1Click's live key" : 'the simulated 1Click key';
  const detail = !signed
    ? 'Signature does not verify'
    : !bound
      ? 'Signed, but the quote does not match this sale'
      : !costOk
        ? 'Signed, but its cost is above the fee bound'
        : `Signed by ${who}`;
  return check('quote', label, signed && bound && costOk, detail);
}

/** An end-of-plan release: no enclave involved; the registry may pay only the beneficiary. */
function verifyRelease(receipt: ChainReceipt, plan: ChainPlan): ReceiptVerification {
  const to = receipt.receiver.toLowerCase();
  const beneficiary = [plan.beneficiary.near_account, plan.beneficiary.evm_address ?? '']
    .filter(Boolean)
    .map((x) => x.toLowerCase());
  const checks = [
    check(
      'release',
      'Release paid only the beneficiary',
      beneficiary.includes(to),
      receipt.receiver,
    ),
    check('settled', 'Registry finished the release', receipt.status === 'done', receipt.status),
  ];
  return {
    seq: receipt.seq,
    ok: checks.every((c) => c.status === 'pass'),
    complete: true,
    simulatedAttestation: false,
    checks,
  };
}

/** A finished plan's published terms, as the registry stores them (`get_reveal`). */
export interface ChainReveal {
  plan_json: string;
  salt: string;
  revealed_at_ms: number;
}

export interface RevealVerification {
  ok: boolean;
  plan: SealedPlan | null;
  checks: Check[];
}

/**
 * Checks a revealed plan in the browser: the terms and salt hash to the commitment the plan made
 * on day one, and every sale stayed inside the terms that were sealed (which receipts could only
 * answer yes or no about while the plan ran).
 */
export function verifyReveal(
  reveal: ChainReveal,
  plan: ChainPlan,
  receipts: ChainReceipt[],
): RevealVerification {
  const checks: Check[] = [];
  const digest = sha256Hex(concatBytes(utf8ToBytes(reveal.plan_json), hexToBytes(reveal.salt)));
  checks.push(
    check(
      'reveal-commitment',
      'sha256(revealed terms ‖ salt) equals the on-chain commitment',
      digest === plan.commitment,
      digest,
    ),
  );
  let sealed: SealedPlan | null = null;
  try {
    sealed = SealedPlan.parse(JSON.parse(reveal.plan_json));
  } catch {
    sealed = null;
  }
  checks.push(check('reveal-format', 'Revealed terms are a well-formed plan', sealed !== null));
  if (!sealed) return { ok: false, plan: null, checks };

  const l = planLimits(sealed);
  const sales = receipts.filter((r) => r.kind === 'sale' && r.status === 'done');
  const perPeriod = new Map<number, bigint>();
  let overTx = 0;
  let overPeriod = 0;
  let belowFloor = 0;
  let tooClose = 0;
  let outside = 0;
  let last: number | null = null;
  for (const r of sales) {
    const amount = BigInt(r.amount);
    if (amount > l.perTx) overTx += 1;
    const sold = (perPeriod.get(r.period_index) ?? 0n) + amount;
    perPeriod.set(r.period_index, sold);
    if (sold > l.perPeriod) overPeriod += 1;
    const minOut = BigInt(r.settlement?.min_amount_out ?? '0');
    if (!meetsFloor(amount, minOut, l.floorE6, plan.token_decimals, plan.quote_decimals))
      belowFloor += 1;
    if (last !== null && r.created_at_ms - last < l.minGapMs) tooClose += 1;
    if (r.created_at_ms < l.startMs || r.created_at_ms >= l.endMs) outside += 1;
    last = r.created_at_ms;
  }
  const n = sales.length;
  checks.push(
    check('reveal-tx', `Every sale within the sealed per-sale limit (${n} checked)`, overTx === 0),
  );
  checks.push(check('reveal-period', 'Every period within the sealed budget', overPeriod === 0));
  checks.push(
    check('reveal-floor', 'Every guaranteed price at or above the sealed floor', belowFloor === 0),
  );
  checks.push(check('reveal-gap', 'Sales at least the sealed minimum gap apart', tooClose === 0));
  checks.push(check('reveal-window', 'Sales only inside the plan’s start and end', outside === 0));
  return { ok: checks.every((c) => c.status === 'pass'), plan: sealed, checks };
}
