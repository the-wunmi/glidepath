import { secp256k1 } from '@noble/curves/secp256k1.js';
import { bytesToHex, hexToBytes } from '@vsp/core';
import { publicKeyToAddress } from 'viem/accounts';
import { describe, expect, it } from 'vitest';
import {
  derivationTweak,
  deriveEvmAddress,
  derivePublicKey,
  deriveSecretKey,
  erc20TransferTx,
  nearSecpKey,
  recoverSigner,
  signedTx,
  signPayload,
  unsignedTxHash,
} from '../src/index.ts';

// Live values read from v1.signer on 2026-11-11.
const MAINNET_ROOT =
  'secp256k1:3tFRbMqmoa6AAALMrEFAYCEoHcqKxeW38YptwowBVBtXK1vo36HDbUWuR6EZmoK4JcH6HDkNMGGqP1ouV7VZUWya';
const MAINNET_DERIVED =
  'secp256k1:5zL9u9afiFPPrPmnH7rEz2t3szev5eZ7wXCwzYq37GYyCbJq3YNU31N4LTULioaw3chJx674XUncmYKiSCd3AxxT';

describe('Chain Signatures derivation', () => {
  it('reproduces the live mainnet derived key for example.near / ethereum-1', () => {
    expect(nearSecpKey(derivePublicKey(MAINNET_ROOT, 'example.near', 'ethereum-1'))).toBe(
      MAINNET_DERIVED,
    );
  });

  it('turns the derived key into the same EVM address as viem does', () => {
    const point = derivePublicKey(MAINNET_ROOT, 'example.near', 'ethereum-1');
    expect(deriveEvmAddress(MAINNET_ROOT, 'example.near', 'ethereum-1')).toBe(
      publicKeyToAddress(`0x${point.toHex(false)}`).toLowerCase(),
    );
  });

  it('gives a different address to a different predecessor on the same path', () => {
    const root = nearSecpKey(secp256k1.Point.BASE.multiply(5n));
    expect(deriveEvmAddress(root, 'registry.test.near', 'plan/1')).not.toBe(
      deriveEvmAddress(root, 'founder.test.near', 'plan/1'),
    );
  });
});

describe('simulated MPC signing', () => {
  it('signs a transaction hash that recovers to the derived address', async () => {
    const rootSecret = bytesToHex(secp256k1.utils.randomSecretKey());
    const rootPublic = nearSecpKey(
      secp256k1.Point.fromBytes(secp256k1.getPublicKey(hexToBytes(rootSecret), false)),
    );
    const tweak = derivationTweak('registry.test.near', 'plan/7');
    const tx = erc20TransferTx({
      chainId: 31337,
      token: '0x5fbdb2315678afecb367f032d93f642f64180aa3',
      to: '0x000000000000000000000000000000000000dead',
      amount: 10n ** 18n,
      nonce: 0,
      gasLimit: 80_000n,
      maxFeePerGas: 2_000_000_000n,
      maxPriorityFeePerGas: 1_000_000_000n,
    });
    const hash = unsignedTxHash(tx);
    const response = signPayload(deriveSecretKey(rootSecret, tweak), hexToBytes(hash.slice(2)));
    expect((await recoverSigner(hash, response)).toLowerCase()).toBe(
      deriveEvmAddress(rootPublic, 'registry.test.near', 'plan/7').toLowerCase(),
    );
    expect(signedTx(tx, response).startsWith('0x02')).toBe(true);
  });
});
