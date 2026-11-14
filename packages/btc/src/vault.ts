import { derivePublicKey } from '@glidepath/chainsig';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import {
  bip143Sighash,
  DUST_SATS,
  derSignature,
  estimatedVsize,
  hash160,
  p2wpkhAddress,
  p2wpkhScript,
  SEQUENCE_RBF,
  scriptForAddress,
  serializeSigned,
  serializeUnsigned,
  TX_VERSION,
  type Tx,
  type TxOutput,
  txid,
  verifyDer,
} from './bitcoin.ts';

/** The vault contract's views (contracts/btc-vault), as JSON. Satoshi amounts are strings. */
export interface VaultConfig {
  signer_contract: string;
  min_delay_ms: number;
  max_delay_ms: number;
  next_vault_id: number;
  max_guardians: number;
  max_inputs: number;
  dust_sats: string;
  min_fee_rate_sat_vb: number;
  max_withdrawal_fee_rate_sat_vb: number;
  /** Claw-backs' cap. */
  max_fee_rate_sat_vb: number;
  network: string;
}

export interface VaultView {
  id: number;
  owner: string;
  guardians: string[];
  recovery_address: string;
  delay_ms: number;
  path: string;
  /** Compressed key, hex; null until the signer answered. */
  public_key: string | null;
  address: string | null;
  open_withdrawal: number | null;
  open_clawback: number | null;
  spend_count: number;
  created_at_ms: number;
}

export type SpendStatus = 'pending' | 'signing' | 'signed' | 'vetoed' | 'cancelled';

export interface MpcSignatureView {
  big_r: string;
  s: string;
  recovery_id: number;
}

export interface SpendView {
  vault_id: number;
  id: number;
  kind: 'withdrawal' | 'clawback';
  status: SpendStatus;
  requested_by: string;
  requested_at_ms: number;
  effective_at_ms: number;
  destination: string;
  amount: string;
  change: string;
  fee: string;
  inputs: { txid: string; vout: number; amount: string; signature: MpcSignatureView | null }[];
  vetoed_by: string | null;
  /** Signing rounds started; after the first, signatures may be public: no veto, only claw-back. */
  sign_rounds: number;
  signed_at_ms: number | null;
  unsigned_tx: string;
  sighashes: string[];
}

/** A UTXO to spend, in the contract's argument shape. */
export interface VaultInput {
  txid: string;
  vout: number;
  amount: bigint;
}

/** The vault's compressed key: the MPC root key tweaked for (vault contract, path). */
export const vaultPublicKey = (rootPublicKey: string, contractId: string, path: string) =>
  derivePublicKey(rootPublicKey, contractId, path).toBytes(true);

/** The vault's testnet4 P2WPKH address, derived without asking the contract. */
export const vaultAddress = (rootPublicKey: string, contractId: string, path: string): string =>
  p2wpkhAddress(vaultPublicKey(rootPublicKey, contractId, path));

/**
 * The only transaction a spend can sign, built exactly as the contract builds it: the inputs in
 * order, `amount` to the destination, then change (if any) to the vault's own address.
 */
export function spendTx(
  spend: Pick<SpendView, 'destination' | 'amount' | 'change' | 'inputs'>,
  publicKey: Uint8Array,
): Tx {
  const destination = scriptForAddress(spend.destination);
  if (!destination) throw new Error(`Not a testnet4 address: ${spend.destination}`);
  const outputs: TxOutput[] = [{ value: BigInt(spend.amount), script: destination }];
  const change = BigInt(spend.change);
  if (change > 0n) outputs.push({ value: change, script: p2wpkhScript(hash160(publicKey)) });
  return {
    version: TX_VERSION,
    locktime: 0,
    inputs: spend.inputs.map((i) => ({
      txid: i.txid,
      vout: i.vout,
      amount: BigInt(i.amount),
      sequence: SEQUENCE_RBF,
    })),
    outputs,
  };
}

export const spendSighashes = (tx: Tx, publicKey: Uint8Array): string[] =>
  tx.inputs.map((_, i) => bytesToHex(bip143Sighash(tx, i, hash160(publicKey))));

export interface SignedSpend {
  txid: string;
  hex: string;
  vsize: number;
}

/**
 * Rebuilds a signed spend from the contract's record alone and checks it before anyone broadcasts:
 * the rebuilt transaction and hashes must equal the contract's, and every stored MPC signature must
 * verify against the vault key. Throws on any mismatch.
 */
export function assembleSpend(spend: SpendView, publicKeyHex: string): SignedSpend {
  const publicKey = hexToBytes(publicKeyHex);
  const tx = spendTx(spend, publicKey);
  if (bytesToHex(serializeUnsigned(tx)) !== spend.unsigned_tx)
    throw new Error('The rebuilt transaction differs from the contract’s');
  const sighashes = spendSighashes(tx, publicKey);
  if (sighashes.join() !== spend.sighashes.join())
    throw new Error('The rebuilt signature hashes differ from the contract’s');
  const witnesses = spend.inputs.map((input, i): [Uint8Array, Uint8Array] => {
    if (!input.signature) throw new Error(`Input ${i} is not signed yet`);
    const r = BigInt(`0x${input.signature.big_r.slice(2)}`);
    const s = BigInt(`0x${input.signature.s}`);
    const der = derSignature(r, s);
    if (!verifyDer(der, hexToBytes(sighashes[i] ?? ''), publicKey))
      throw new Error(`Input ${i}'s signature does not verify against the vault key`);
    return [der, publicKey];
  });
  const signed = serializeSigned(tx, witnesses);
  const base = serializeUnsigned(tx).length;
  return {
    txid: txid(tx),
    hex: bytesToHex(signed),
    vsize: Math.ceil((base * 3 + signed.length) / 4),
  };
}

export interface Utxo {
  txid: string;
  vout: number;
  value: bigint;
}

export interface PlannedSpend {
  inputs: VaultInput[];
  fee: bigint;
  change: bigint;
}

/**
 * Picks the largest UTXOs (at most `maxInputs`) that pay `amount` plus the fee at `feeRate`
 * sat/vB, with change back to the vault; change below dust goes to the fee instead.
 */
export function planWithdrawal(
  utxos: Utxo[],
  destination: string,
  amount: bigint,
  feeRate: bigint,
  maxInputs: number,
): PlannedSpend {
  const script = scriptForAddress(destination);
  if (!script) throw new Error(`Not a testnet4 address: ${destination}`);
  const sorted = [...utxos].sort((a, b) => (b.value > a.value ? 1 : b.value < a.value ? -1 : 0));
  const changeScript = { script: new Uint8Array(22) };
  let total = 0n;
  const inputs: VaultInput[] = [];
  for (const utxo of sorted.slice(0, maxInputs)) {
    inputs.push({ txid: utxo.txid, vout: utxo.vout, amount: utxo.value });
    total += utxo.value;
    const fee = estimatedVsize(inputs.length, [{ script }, changeScript]) * feeRate;
    const change = total - amount - fee;
    if (change >= DUST_SATS) return { inputs, fee, change };
    const feeWithoutChange = estimatedVsize(inputs.length, [{ script }]) * feeRate;
    const rest = total - amount - feeWithoutChange;
    if (rest >= 0n) return { inputs, fee: feeWithoutChange + rest, change: 0n };
  }
  throw new Error(`The vault's UTXOs cannot pay ${amount} sats plus the fee`);
}

/** A claw-back sweeps up to `maxInputs` UTXOs to the recovery address at `feeRate` sat/vB. */
export function planClawback(
  utxos: Utxo[],
  recoveryAddress: string,
  feeRate: bigint,
  maxInputs: number,
): PlannedSpend {
  const script = scriptForAddress(recoveryAddress);
  if (!script) throw new Error(`Not a testnet4 address: ${recoveryAddress}`);
  const inputs = utxos
    .slice(0, maxInputs)
    .map((u) => ({ txid: u.txid, vout: u.vout, amount: u.value }));
  return { inputs, fee: estimatedVsize(inputs.length, [{ script }]) * feeRate, change: 0n };
}

/** The contract's JSON shape for inputs (amounts as strings). */
export const inputArgs = (inputs: VaultInput[]) =>
  inputs.map((i) => ({ txid: i.txid, vout: i.vout, amount: i.amount.toString() }));
