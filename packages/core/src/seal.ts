import { chacha20poly1305 } from '@noble/ciphers/chacha.js';
import { x25519 } from '@noble/curves/ed25519.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { z } from 'zod';
import {
  bytesToHex,
  concatBytes,
  fromBase64,
  hexToBytes,
  toBase64,
  utf8ToBytes,
} from './encoding.ts';

/**
 * ECIES to the enclave's X25519 key, the scheme OutLayer uses for secrets:
 * ephemeral X25519 exchange, HKDF-SHA256, ChaCha20-Poly1305. The info string binds the key to this
 * use so a ciphertext made for one purpose cannot be opened as another.
 */
const HKDF_INFO = utf8ToBytes('vsp/seal/v1');

/** A sealed plan is a few hundred bytes; 64 KB stops anyone storing junk through the API. */
const MAX_CIPHERTEXT_CHARS = 65_536;

export const SealedBox = z.object({
  v: z.literal(1),
  epk: z.string().regex(/^[0-9a-f]{64}$/),
  nonce: z.string().regex(/^[0-9a-f]{24}$/),
  ct: z.string().min(1).max(MAX_CIPHERTEXT_CHARS),
});
export type SealedBox = z.infer<typeof SealedBox>;

function deriveKey(shared: Uint8Array, epk: Uint8Array, recipient: Uint8Array): Uint8Array {
  return hkdf(sha256, shared, concatBytes(epk, recipient), HKDF_INFO, 32);
}

export function sealTo(recipientPublicHex: string, plaintext: string): SealedBox {
  const recipient = hexToBytes(recipientPublicHex);
  const esk = x25519.utils.randomSecretKey();
  const epk = x25519.getPublicKey(esk);
  const key = deriveKey(x25519.getSharedSecret(esk, recipient), epk, recipient);
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const ct = chacha20poly1305(key, nonce).encrypt(utf8ToBytes(plaintext));
  return { v: 1, epk: bytesToHex(epk), nonce: bytesToHex(nonce), ct: toBase64(ct) };
}

export function openSealed(secretKey: Uint8Array, box: SealedBox): string {
  const recipient = x25519.getPublicKey(secretKey);
  const epk = hexToBytes(box.epk);
  const key = deriveKey(x25519.getSharedSecret(secretKey, epk), epk, recipient);
  const pt = chacha20poly1305(key, hexToBytes(box.nonce)).decrypt(fromBase64(box.ct));
  return new TextDecoder().decode(pt);
}
