import { secp256k1 } from '@noble/curves/secp256k1.js';
import { sha3_256 } from '@noble/hashes/sha3.js';
import { bytesToHex, formatNearKey, hexToBytes, parseNearKey, utf8ToBytes } from '@vsp/core';
import {
  encodeFunctionData,
  erc20Abi,
  type Hex,
  keccak256,
  recoverAddress,
  serializeTransaction,
  type TransactionSerializableEIP1559,
} from 'viem';

/**
 * Chain Signatures key derivation, exactly as near/mpc crates/near-mpc-crypto-types/src/kdf.rs
 * (as the live signer does; checked against v1.signer on 2026-11-11): tweak =
 * SHA3-256(prefix ‖ predecessor ‖ "," ‖ path), read big-endian and rejected if not below n;
 * derived key = root + tweak·G.
 */
export const TWEAK_DERIVATION_PREFIX = 'near-mpc-recovery v0.1.0 epsilon derivation:';

const Point = secp256k1.Point;
const N = Point.Fn.ORDER;

export function derivationTweak(predecessor: string, path: string): bigint {
  const digest = sha3_256(utf8ToBytes(`${TWEAK_DERIVATION_PREFIX}${predecessor},${path}`));
  const tweak = BigInt(`0x${bytesToHex(digest)}`);
  if (tweak >= N) throw new Error('Tweak is not a valid scalar');
  return tweak;
}

export const tweakHex = (tweak: bigint): string => tweak.toString(16).padStart(64, '0');

/** Accepts NEAR's "secp256k1:<base58 x‖y>" or hex SEC1 (33 or 65 bytes). */
export function parseSecpPublicKey(key: string) {
  if (key.startsWith('secp256k1:')) {
    const { bytes } = parseNearKey(key);
    return Point.fromBytes(Uint8Array.from([4, ...bytes]));
  }
  return Point.fromHex(key.replace(/^0x/, ''));
}

/** NEAR's text form for a secp256k1 key: 64 bytes x‖y, no SEC1 prefix. */
export const nearSecpKey = (point: ReturnType<typeof parseSecpPublicKey>): string =>
  formatNearKey('secp256k1', point.toBytes(false).slice(1));

export function derivePublicKey(rootPublicKey: string, predecessor: string, path: string) {
  const tweak = derivationTweak(predecessor, path);
  return Point.BASE.multiply(tweak).add(parseSecpPublicKey(rootPublicKey));
}

export function evmAddressOf(point: ReturnType<typeof parseSecpPublicKey>): Hex {
  const hash = keccak256(point.toBytes(false).slice(1));
  return `0x${hash.slice(-40)}` as Hex;
}

/** The EVM address the MPC network controls for (predecessor, path). */
export const deriveEvmAddress = (rootPublicKey: string, predecessor: string, path: string): Hex =>
  evmAddressOf(derivePublicKey(rootPublicKey, predecessor, path));

/** Plans sign under this path, so each plan has its own external address. */
export const planPath = (planId: number): string => `plan/${planId}`;

/** The MPC signer's response, as serialised by near/mpc (tag "scheme"). */
export interface SignatureResponse {
  scheme: 'Secp256k1';
  big_r: { affine_point: string };
  s: { scalar: string };
  recovery_id: number;
}

/** Simulator side: derived secret = root secret + tweak (mod n). */
export function deriveSecretKey(rootSecretHex: string, tweak: bigint): Uint8Array {
  const root = BigInt(`0x${rootSecretHex}`);
  const derived = (root + tweak) % N;
  return hexToBytes(derived.toString(16).padStart(64, '0'));
}

/**
 * Signs the 32-byte payload as a prehash (no further hashing), RFC 6979 nonce, low s, the way the
 * MPC network does. big_r is R compressed; for a low-s signature R's parity is the recovery id.
 */
export function signPayload(secretKey: Uint8Array, payload: Uint8Array): SignatureResponse {
  if (payload.length !== 32) throw new Error('Payload must be 32 bytes');
  const sig = secp256k1.Signature.fromBytes(
    secp256k1.sign(payload, secretKey, { prehash: false, format: 'recovered' }),
    'recovered',
  );
  const recovery = sig.recovery ?? 0;
  const prefix = recovery & 1 ? '03' : '02';
  return {
    scheme: 'Secp256k1',
    big_r: { affine_point: prefix + sig.r.toString(16).padStart(64, '0') },
    s: { scalar: sig.s.toString(16).padStart(64, '0') },
    recovery_id: recovery,
  };
}

export function signatureParts(response: SignatureResponse) {
  return {
    r: `0x${response.big_r.affine_point.slice(2)}` as Hex,
    s: `0x${response.s.scalar}` as Hex,
    yParity: response.recovery_id,
  };
}

export interface Erc20TransferParams {
  chainId: number;
  token: Hex;
  to: Hex;
  amount: bigint;
  nonce: number;
  gasLimit: bigint;
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
}

/**
 * The ERC-20 transfer the registry builds and asks the MPC network to sign. The registry builds the
 * same bytes itself from the request; this copy lets relayers and verifiers check the hash.
 */
export function erc20TransferTx(p: Erc20TransferParams): TransactionSerializableEIP1559 {
  return {
    type: 'eip1559',
    chainId: p.chainId,
    nonce: p.nonce,
    to: p.token,
    value: 0n,
    gas: p.gasLimit,
    maxFeePerGas: p.maxFeePerGas,
    maxPriorityFeePerGas: p.maxPriorityFeePerGas,
    data: encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [p.to, p.amount] }),
    accessList: [],
  };
}

export const unsignedTxHex = (tx: TransactionSerializableEIP1559): Hex => serializeTransaction(tx);

export const unsignedTxHash = (tx: TransactionSerializableEIP1559): Hex =>
  keccak256(serializeTransaction(tx));

/** The broadcastable transaction: the unsigned one plus the MPC signature. */
export const signedTx = (tx: TransactionSerializableEIP1559, response: SignatureResponse): Hex =>
  serializeTransaction(tx, signatureParts(response));

/** Recovers the address that produced an MPC signature over a hash. */
export const recoverSigner = async (hash: Hex, response: SignatureResponse): Promise<Hex> =>
  (await recoverAddress({ hash, signature: signatureParts(response) })).toLowerCase() as Hex;
