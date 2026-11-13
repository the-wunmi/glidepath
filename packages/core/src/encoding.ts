import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, hexToBytes, utf8ToBytes } from '@noble/hashes/utils.js';

export { bytesToHex, hexToBytes, utf8ToBytes };

/** JSON has no bigint, so amounts are written as strings of base units. */
export const toJson = (value: unknown): string =>
  JSON.stringify(value, (_k, v) => (typeof v === 'bigint' ? v.toString() : v));

const compareKeys = ([a]: [string, unknown], [b]: [string, unknown]) =>
  a < b ? -1 : a > b ? 1 : 0;

/**
 * Deterministic JSON: keys sorted at every level, bigints as strings, no whitespace. The plan
 * commitment is computed over this, so the browser and the enclave must agree byte for byte.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_k, v) => {
    if (typeof v === 'bigint') return v.toString();
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      return Object.fromEntries(Object.entries(v).sort(compareKeys));
    }
    return v;
  });
}

export const sha256Hex = (bytes: Uint8Array | string): string =>
  bytesToHex(sha256(typeof bytes === 'string' ? utf8ToBytes(bytes) : bytes));

export function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

export const toBase64 = (bytes: Uint8Array): string => {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
};

export const fromBase64 = (value: string): Uint8Array =>
  Uint8Array.from(atob(value), (c) => c.charCodeAt(0));

const BASE58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

/** NEAR writes public keys as <curve>:<base58>; this is the Bitcoin alphabet. */
export function base58Encode(bytes: Uint8Array): string {
  let n = 0n;
  for (const b of bytes) n = (n << 8n) | BigInt(b);
  let out = '';
  while (n > 0n) {
    out = BASE58[Number(n % 58n)] + out;
    n /= 58n;
  }
  for (const b of bytes) {
    if (b !== 0) break;
    out = `1${out}`;
  }
  return out;
}

export function base58Decode(value: string): Uint8Array {
  let n = 0n;
  for (const c of value) {
    const i = BASE58.indexOf(c);
    if (i < 0) throw new Error('Invalid base58 string');
    n = n * 58n + BigInt(i);
  }
  const bytes: number[] = [];
  while (n > 0n) {
    bytes.unshift(Number(n & 0xffn));
    n >>= 8n;
  }
  for (const c of value) {
    if (c !== '1') break;
    bytes.unshift(0);
  }
  return Uint8Array.from(bytes);
}

/** Splits ed25519:<base58> / secp256k1:<base58> into curve and raw key bytes. */
export function parseNearKey(key: string): { curve: string; bytes: Uint8Array } {
  const [curve, data] = key.split(':');
  if (!curve || !data) throw new Error(`Invalid key: ${key}`);
  return { curve, bytes: base58Decode(data) };
}

export const formatNearKey = (curve: 'ed25519' | 'secp256k1', bytes: Uint8Array): string =>
  `${curve}:${base58Encode(bytes)}`;
