import { ed25519 } from '@noble/curves/ed25519.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { z } from 'zod';
import {
  bytesToHex,
  canonicalJson,
  concatBytes,
  hexToBytes,
  parseNearKey,
  sha256Hex,
  utf8ToBytes,
} from './encoding.ts';

/**
 * A SIMULATED TDX quote. Real OutLayer workers produce Intel TDX quotes that the worker registry
 * verifies against Intel collateral; this simulator cannot. It keeps the same structure (five
 * SHA-384 measurements, 64 bytes of report data binding the enclave's keys) and is signed by a
 * simulated vendor key whose seed is public, so the browser can run every check a real verifier
 * would, and the UI labels the result "simulated".
 */
export const SimulatedQuote = z.object({
  format: z.literal('simulated-tdx-v1'),
  measurements: z.object({
    mrtd: z.string().regex(/^[0-9a-f]{96}$/),
    rtmr0: z.string().regex(/^[0-9a-f]{96}$/),
    rtmr1: z.string().regex(/^[0-9a-f]{96}$/),
    rtmr2: z.string().regex(/^[0-9a-f]{96}$/),
    rtmr3: z.string().regex(/^[0-9a-f]{96}$/),
  }),
  /** sha256(ed25519 signing key ‖ x25519 encryption key), zero-padded to 64 bytes as in TDX. */
  report_data: z.string().regex(/^[0-9a-f]{128}$/),
  issued_at: z.iso.datetime(),
  vendor_signature: z.string().regex(/^[0-9a-f]{128}$/),
});
export type SimulatedQuote = z.infer<typeof SimulatedQuote>;

/** Public seed of the simulated vendor key. Anyone can sign with it: this is not a trust root. */
export const SIM_VENDOR_SEED = sha256(utf8ToBytes('verified-sales-plans/simulated-tdx-vendor/v1'));
export const SIM_VENDOR_PUBLIC_KEY = bytesToHex(ed25519.getPublicKey(SIM_VENDOR_SEED));

export function reportDataFor(signingKey: string, encryptionKeyHex: string): string {
  const digest = sha256(concatBytes(parseNearKey(signingKey).bytes, hexToBytes(encryptionKeyHex)));
  return bytesToHex(digest).padEnd(128, '0');
}

const quoteBody = (q: SimulatedQuote) => utf8ToBytes(canonicalJson({ ...q, vendor_signature: '' }));

export function signSimulatedQuote(
  unsigned: Omit<SimulatedQuote, 'vendor_signature'>,
): SimulatedQuote {
  const q = { ...unsigned, vendor_signature: '' };
  return { ...q, vendor_signature: bytesToHex(ed25519.sign(quoteBody(q), SIM_VENDOR_SEED)) };
}

/** The hash the registry stores when an enclave is registered. */
export const quoteHash = (q: SimulatedQuote): string => sha256Hex(canonicalJson(q));

export interface AttestationCheck {
  label: string;
  ok: boolean;
}

/**
 * Every check a verifier runs on a quote, in order. All are real computations over real bytes;
 * only the vendor key is simulated, which `simulated: true` states.
 */
export function verifySimulatedQuote(
  quote: SimulatedQuote,
  expected: {
    signingKey: string;
    encryptionKeyHex: string;
    measurements: SimulatedQuote['measurements'];
    quoteHash: string;
  },
): { simulated: true; checks: AttestationCheck[] } {
  let vendorOk = false;
  try {
    vendorOk = ed25519.verify(
      hexToBytes(quote.vendor_signature),
      quoteBody(quote),
      hexToBytes(SIM_VENDOR_PUBLIC_KEY),
    );
  } catch {
    vendorOk = false;
  }
  const m = quote.measurements;
  const e = expected.measurements;
  return {
    simulated: true,
    checks: [
      { label: 'Quote signed by the (simulated) TDX vendor key', ok: vendorOk },
      {
        label: 'Measurements match the ones registered on-chain',
        ok:
          m.mrtd === e.mrtd &&
          m.rtmr0 === e.rtmr0 &&
          m.rtmr1 === e.rtmr1 &&
          m.rtmr2 === e.rtmr2 &&
          m.rtmr3 === e.rtmr3,
      },
      {
        label: "Report data binds the enclave's signing and encryption keys",
        ok: quote.report_data === reportDataFor(expected.signingKey, expected.encryptionKeyHex),
      },
      {
        label: 'Quote hash matches the on-chain registration',
        ok: quoteHash(quote) === expected.quoteHash,
      },
    ],
  };
}
