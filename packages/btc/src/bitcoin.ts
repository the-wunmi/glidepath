import { secp256k1 } from '@noble/curves/secp256k1.js';
import { ripemd160 } from '@noble/hashes/legacy.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, concatBytes, hexToBytes } from '@noble/hashes/utils.js';
import { bech32, bech32m, createBase58check } from '@scure/base';

/**
 * Bitcoin testnet4 encoding, mirroring contracts/btc-vault/src/bitcoin.rs byte for byte (both are
 * checked against contracts/res/btc-vault-vectors.json): addresses, the unsigned transaction, the
 * BIP143 segwit v0 signature hash, and the signed transaction with its witnesses.
 */
export const BTC_NETWORK = {
  name: 'testnet4',
  hrp: 'tb',
  p2pkhVersion: 0x6f,
  p2shVersion: 0xc4,
} as const;

export const TX_VERSION = 2;
/** Every vault input signals replace-by-fee (BIP125), so a claw-back can replace a withdrawal. */
export const SEQUENCE_RBF = 0xfffffffd;
export const SIGHASH_ALL = 1;
/** The largest standard dust threshold; the vault refuses smaller outputs. */
export const DUST_SATS = 546n;
const MAX_ADDRESS_LEN = 90;

const base58check = createBase58check(sha256);

export interface TxInput {
  /** Display order, as explorers print it. */
  txid: string;
  vout: number;
  /** Satoshis held by the output being spent (BIP143 signs it). */
  amount: bigint;
  sequence: number;
}

export interface TxOutput {
  value: bigint;
  script: Uint8Array;
}

export interface Tx {
  version: number;
  locktime: number;
  inputs: TxInput[];
  outputs: TxOutput[];
}

export const doubleSha256 = (data: Uint8Array): Uint8Array => sha256(sha256(data));
export const hash160 = (data: Uint8Array): Uint8Array => ripemd160(sha256(data));

export const p2wpkhScript = (pubkeyHash: Uint8Array): Uint8Array =>
  concatBytes(Uint8Array.of(0x00, 0x14), pubkeyHash);

export function p2wpkhAddress(compressedPublicKey: Uint8Array): string {
  if (compressedPublicKey.length !== 33) throw new Error('Expected a 33-byte compressed key');
  const program = hash160(compressedPublicKey);
  return bech32.encode(BTC_NETWORK.hrp, [0, ...bech32.toWords(program)]);
}

/**
 * The output script a testnet address pays to (P2WPKH, P2WSH, P2TR, P2PKH, P2SH), or null for
 * anything else: mainnet addresses, and witness versions anyone could spend today.
 */
export function scriptForAddress(address: string): Uint8Array | null {
  if (!address || address.length > MAX_ADDRESS_LEN) return null;
  const lower = address.toLowerCase();
  if (lower.startsWith(`${BTC_NETWORK.hrp}1`)) {
    if (address !== lower && address !== address.toUpperCase()) return null;
    return segwitScript(lower);
  }
  return base58Script(address);
}

function segwitScript(address: string): Uint8Array | null {
  // BIP350: witness version 0 uses the bech32 checksum, versions 1 and above bech32m.
  const v0 = bech32.decodeUnsafe(address, MAX_ADDRESS_LEN);
  const decoded = v0?.words[0] === 0 ? v0 : bech32m.decodeUnsafe(address, MAX_ADDRESS_LEN);
  if (!decoded || decoded.prefix !== BTC_NETWORK.hrp) return null;
  const [witnessVersion, ...words] = decoded.words;
  if (witnessVersion === undefined || witnessVersion > 16) return null;
  if (witnessVersion === 0 && decoded !== v0) return null;
  let program: Uint8Array;
  try {
    program = bech32.fromWords(words);
  } catch {
    return null;
  }
  if (program.length < 2 || program.length > 40) return null;
  if (witnessVersion === 0 && program.length !== 20 && program.length !== 32) return null;
  // Versions 2-16, and version 1 with anything but a 32-byte (Taproot) program, have no meaning
  // yet: anyone can spend such an output today.
  if (witnessVersion > 1 || (witnessVersion === 1 && program.length !== 32)) return null;
  const opcode = witnessVersion === 0 ? 0 : 0x50 + witnessVersion;
  return concatBytes(Uint8Array.of(opcode, program.length), program);
}

function base58Script(address: string): Uint8Array | null {
  let payload: Uint8Array;
  try {
    payload = base58check.decode(address);
  } catch {
    return null;
  }
  if (payload.length !== 21) return null;
  const hash = payload.slice(1);
  if (payload[0] === BTC_NETWORK.p2pkhVersion)
    return concatBytes(Uint8Array.of(0x76, 0xa9, 0x14), hash, Uint8Array.of(0x88, 0xac));
  if (payload[0] === BTC_NETWORK.p2shVersion)
    return concatBytes(Uint8Array.of(0xa9, 0x14), hash, Uint8Array.of(0x87));
  return null;
}

class Writer {
  private parts: Uint8Array[] = [];
  bytes(b: Uint8Array) {
    this.parts.push(b);
    return this;
  }
  u32(n: number) {
    const b = new Uint8Array(4);
    new DataView(b.buffer).setUint32(0, n >>> 0, true);
    return this.bytes(b);
  }
  u64(n: bigint) {
    const b = new Uint8Array(8);
    new DataView(b.buffer).setBigUint64(0, n, true);
    return this.bytes(b);
  }
  varint(n: number) {
    if (n < 0xfd) return this.bytes(Uint8Array.of(n));
    if (n <= 0xffff) return this.bytes(Uint8Array.of(0xfd, n & 0xff, n >> 8));
    return this.bytes(Uint8Array.of(0xfe)).u32(n);
  }
  varBytes(b: Uint8Array) {
    return this.varint(b.length).bytes(b);
  }
  outpoint(input: TxInput) {
    return this.bytes(hexToBytes(input.txid).reverse()).u32(input.vout);
  }
  output(output: TxOutput) {
    return this.u64(output.value).varBytes(output.script);
  }
  done(): Uint8Array {
    return concatBytes(...this.parts);
  }
}

/** The non-witness serialisation: what the txid hashes. */
export function serializeUnsigned(tx: Tx): Uint8Array {
  const w = new Writer().u32(tx.version).varint(tx.inputs.length);
  for (const input of tx.inputs) w.outpoint(input).varint(0).u32(input.sequence);
  w.varint(tx.outputs.length);
  for (const output of tx.outputs) w.output(output);
  return w.u32(tx.locktime).done();
}

/** Display-order txid (the same with or without witnesses). */
export const txid = (tx: Tx): string => bytesToHex(doubleSha256(serializeUnsigned(tx)).reverse());

/** BIP143 signature hash (SIGHASH_ALL) of input `index`, spent from the P2WPKH of `pubkeyHash`. */
export function bip143Sighash(tx: Tx, index: number, pubkeyHash: Uint8Array): Uint8Array {
  const input = tx.inputs[index];
  if (!input) throw new Error(`No input ${index}`);
  const prevouts = new Writer();
  const sequences = new Writer();
  for (const i of tx.inputs) {
    prevouts.outpoint(i);
    sequences.u32(i.sequence);
  }
  const outputs = new Writer();
  for (const o of tx.outputs) outputs.output(o);
  const scriptCode = concatBytes(
    Uint8Array.of(0x19, 0x76, 0xa9, 0x14),
    pubkeyHash,
    Uint8Array.of(0x88, 0xac),
  );
  const preimage = new Writer()
    .u32(tx.version)
    .bytes(doubleSha256(prevouts.done()))
    .bytes(doubleSha256(sequences.done()))
    .outpoint(input)
    .bytes(scriptCode)
    .u64(input.amount)
    .u32(input.sequence)
    .bytes(doubleSha256(outputs.done()))
    .u32(tx.locktime)
    .u32(SIGHASH_ALL)
    .done();
  return doubleSha256(preimage);
}

/**
 * Virtual size of the signed transaction when every input is P2WPKH, with the longest (72-byte)
 * signature, exactly as the vault estimates it for its fee checks.
 */
export function estimatedVsize(inputCount: number, outputs: { script: Uint8Array }[]): bigint {
  let weight = 10 * 4 + 2 + inputCount * (41 * 4 + 108);
  for (const o of outputs) weight += (8 + 1 + o.script.length) * 4;
  return BigInt(Math.ceil(weight / 4));
}

const N = secp256k1.Point.Fn.ORDER;

/** DER signature with the sighash byte, s normalised low (BIP146: the network relays only low s). */
export function derSignature(r: bigint, s: bigint): Uint8Array {
  const low = s > N / 2n ? N - s : s;
  const der = new secp256k1.Signature(r, low).toBytes('der');
  return concatBytes(der, Uint8Array.of(SIGHASH_ALL));
}

/** True when the DER signature (with or without its sighash byte) signs `sighash` for `publicKey`. */
export function verifyDer(
  signature: Uint8Array,
  sighash: Uint8Array,
  publicKey: Uint8Array,
): boolean {
  const der = signature.at(-1) === SIGHASH_ALL ? signature.slice(0, -1) : signature;
  return secp256k1.verify(der, sighash, publicKey, { prehash: false, format: 'der' });
}

/** The broadcastable segwit transaction: each input's witness is [signature, compressed key]. */
export function serializeSigned(tx: Tx, witnesses: [Uint8Array, Uint8Array][]): Uint8Array {
  if (witnesses.length !== tx.inputs.length) throw new Error('One witness per input');
  const w = new Writer().u32(tx.version).bytes(Uint8Array.of(0x00, 0x01)).varint(tx.inputs.length);
  for (const input of tx.inputs) w.outpoint(input).varint(0).u32(input.sequence);
  w.varint(tx.outputs.length);
  for (const output of tx.outputs) w.output(output);
  for (const [signature, publicKey] of witnesses)
    w.varint(2).varBytes(signature).varBytes(publicKey);
  return w.u32(tx.locktime).done();
}
