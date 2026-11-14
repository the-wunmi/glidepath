import { ed25519 } from '@noble/curves/ed25519.js';
import {
  fromBase64,
  oneclickSignedBytes,
  parseNearKey,
  parseQuoteTerms,
  SimulatedQuote,
  sha256Hex,
  signingBytes,
  verifySimulatedQuote,
} from '@vsp/core';
import {
  ATTESTATION_LABELS,
  type ChainTrust,
  type ChainTrustReceipt,
  TRUST_MIN_TRADE_USD_E6,
  TRUST_TRADE_DOMAIN,
  type TradeAttestation,
  type TradeRequest,
  trustActionJson,
} from './messages.ts';
import { quoteTurnoverE6, routesOnChain, slippageFloor, trustCostWithinBound } from './trade.ts';

/**
 * Checks of one trust receipt that run in the browser over bytes read from the chain, the same way
 * plan receipts are checked (`@vsp/verify`). The result says yes or no per check and never
 * repeats amounts: the page shows the statements, not the holdings.
 */

export type TrustCheckStatus = 'pass' | 'fail' | 'skip';

export interface TrustCheck {
  id: string;
  label: string;
  status: TrustCheckStatus;
}

export interface TrustReceiptVerification {
  seq: number;
  ok: boolean;
  complete: boolean;
  simulatedAttestation: boolean;
  checks: TrustCheck[];
}

/** An enclave on the trust contract's allowlist (`get_enclaves`). */
export interface TrustEnclaveEntry {
  public_key: string;
  measurements: { mrtd: string; rtmr0: string; rtmr1: string; rtmr2: string; rtmr3: string };
  quote_hash: string;
  active_from_ms: number;
  revoked_at_ms: number | null;
}

/** A 1Click quote key and when it was in force (`get_quote_signers`). */
export interface TrustQuoteSigner {
  public_key: string;
  active_from_ms: number;
  replaced_at_ms: number | null;
}

const result = (id: string, label: string, ok: boolean): TrustCheck => ({
  id,
  label,
  status: ok ? 'pass' : 'fail',
});

export function verifyTrustReceipt(
  receipt: ChainTrustReceipt,
  trust: ChainTrust,
  enclaves: TrustEnclaveEntry[],
  attestation: { quote: unknown; encryptionKeyHex: string } | null,
  quoteSigners: TrustQuoteSigner[],
): TrustReceiptVerification {
  const checks: TrustCheck[] = [];
  const done = (simulated: boolean): TrustReceiptVerification => ({
    seq: receipt.seq,
    ok: checks.every((c) => c.status !== 'fail'),
    complete: checks.every((c) => c.status !== 'skip'),
    simulatedAttestation: simulated,
    checks,
  });
  if (!receipt.request_json || !receipt.signature || !receipt.enclave_key) {
    checks.push(result('signed', 'The receipt carries an enclave-signed request', false));
    return done(true);
  }

  // 1. The enclave's signature over the exact bytes stored on-chain.
  let signed = false;
  try {
    signed = ed25519.verify(
      fromBase64(receipt.signature),
      signingBytes(TRUST_TRADE_DOMAIN, receipt.request_json),
      parseNearKey(receipt.enclave_key).bytes,
    );
  } catch {
    signed = false;
  }
  checks.push(result('signature', 'Enclave signature is valid over the stored request', signed));

  // 2. The key was on the contract's allowlist when the trade happened.
  const enclave = enclaves.find((x) => x.public_key === receipt.enclave_key);
  checks.push(
    result(
      'allowlist',
      'Signing key was on the on-chain enclave allowlist at the time',
      !!enclave &&
        enclave.active_from_ms <= receipt.created_at_ms &&
        (enclave.revoked_at_ms === null || enclave.revoked_at_ms > receipt.created_at_ms),
    ),
  );

  // 3. The attestation binds that key to the registered measurements.
  let simulated = true;
  const parsedQuote = attestation ? SimulatedQuote.safeParse(attestation.quote) : null;
  if (enclave && attestation && parsedQuote?.success) {
    const verdict = verifySimulatedQuote(parsedQuote.data, {
      signingKey: enclave.public_key,
      encryptionKeyHex: attestation.encryptionKeyHex,
      measurements: enclave.measurements,
      quoteHash: enclave.quote_hash,
    });
    simulated = verdict.simulated;
    checks.push(
      result(
        'attestation',
        'Attestation binds the key to the registered measurements (simulated TDX)',
        verdict.checks.every((c) => c.ok),
      ),
    );
  } else {
    checks.push(result('attestation', 'Attestation quote available for the signing key', false));
  }

  let request: TradeRequest | null = null;
  try {
    request = JSON.parse(receipt.request_json) as TradeRequest;
  } catch {
    request = null;
  }
  if (!request) {
    checks.push(result('request', 'Signed request is readable', false));
    return done(simulated);
  }

  // 4. The signed request says what the receipt says.
  checks.push(
    result(
      'binding',
      'Signed request matches the receipt (trust, sequence, commitment, token, amount, receiver)',
      request.trust_id === receipt.trust_id &&
        request.seq === receipt.seq &&
        request.commitment === receipt.commitment &&
        request.origin_token === receipt.token &&
        request.amount === receipt.amount &&
        request.settlement.deposit_address === receipt.receiver,
    ),
  );

  // 5. The enclave's yes/no statements.
  for (const [key, label] of Object.entries(ATTESTATION_LABELS))
    checks.push(
      result(
        `attests-${key}`,
        label,
        request.attestation?.[key as keyof TradeAttestation] === true,
      ),
    );

  // 6. The 1Click quote: signed by the key in force, paying and refunding only the trust.
  const signer = quoteSigners.find(
    (s) =>
      s.active_from_ms <= receipt.created_at_ms &&
      (s.replaced_at_ms === null || s.replaced_at_ms > receipt.created_at_ms),
  );
  const quote = request.settlement.quote;
  let quoteSigned = false;
  try {
    quoteSigned =
      !!signer &&
      ed25519.verify(
        parseNearKey(quote.signature).bytes,
        oneclickSignedBytes(quote.payload),
        parseNearKey(signer.public_key).bytes,
      );
  } catch {
    quoteSigned = false;
  }
  checks.push(
    result('quote-signed', 'The 1Click quote is signed by the registered key', quoteSigned),
  );
  let terms: ReturnType<typeof parseQuoteTerms> | null = null;
  try {
    terms = parseQuoteTerms(quote.payload);
  } catch {
    terms = null;
  }
  const t = terms;
  checks.push(
    result(
      'stays-in-trust',
      'Proceeds and refunds go only to the trust account, on-chain (not inside intents)',
      !!t &&
        t.recipient === trust.trust_account &&
        t.refundTo === trust.trust_account &&
        routesOnChain(t),
    ),
  );
  checks.push(
    result(
      'not-excluded',
      'The asset bought is not on the public exclusion list',
      !!t &&
        t.destinationAsset === receipt.destination_asset &&
        !trust.envelope.excluded_assets.includes(t.destinationAsset),
    ),
  );
  let bounded = false;
  try {
    bounded =
      !!t &&
      t.originAsset === `nep141:${receipt.token}` &&
      t.amountIn === receipt.amount &&
      t.depositAddress === receipt.receiver &&
      trustCostWithinBound(t) &&
      quoteTurnoverE6(t.amountInUsd) >= TRUST_MIN_TRADE_USD_E6 &&
      BigInt(t.minAmountOut) >= slippageFloor(BigInt(t.amountOut)) &&
      quoteTurnoverE6(t.amountInUsd).toString() === receipt.turnover_usd_e6;
  } catch {
    bounded = false;
  }
  checks.push(
    result(
      'quote-bound',
      'The quote is this trade, its cost and slippage within the bounds, its turnover counted',
      bounded,
    ),
  );

  // 7. What the trust account sent matches what was signed.
  checks.push(
    result(
      'action',
      'Transfer the trust account made hashes to the receipt’s action hash',
      sha256Hex(
        trustActionJson(receipt.receiver, receipt.amount, receipt.trust_id, receipt.seq),
      ) === receipt.action_hash,
    ),
  );
  checks.push(
    receipt.status === 'pending'
      ? { id: 'settled', label: 'Contract finished the transfer', status: 'skip' }
      : result('settled', 'Contract finished the transfer', receipt.status === 'done'),
  );
  return done(simulated);
}
