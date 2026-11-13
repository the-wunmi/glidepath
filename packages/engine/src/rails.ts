import { secp256k1 } from '@noble/curves/secp256k1.js';
import { bytesToHex } from '@vsp/core';
import { type EvmClient, SALE_GAS } from '@vsp/evm';
import { actions, KeyPair, type KeyPairString, type NearClient, teraToGas } from '@vsp/near';
import type { SimAsset, SimRails } from '@vsp/oneclick';
import { createWalletClient, erc20Abi, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import type { WorldConfig } from './world.ts';

const NEAR = 10n ** 24n;
/** Gas money the simulated 1Click sends a deposit address before it can refund from it. */
const REFUND_GAS_NEAR = NEAR / 20n;
/** About 7 hours of Sepolia blocks; 1Click quotes expire long before that. */
const DEPOSIT_LOOKBACK_BLOCKS = 2_000n;

/**
 * The 1Click simulator's hands on the local chains: fresh deposit addresses it holds keys for,
 * deposit detection, refunds from the deposit address, and payouts from the simulated solver.
 */
export function createSimRails(near: NearClient, evm: EvmClient, w: WorldConfig): SimRails {
  const solver = near.account(w.solver, w.keys[w.solver] as KeyPairString);
  const nearOk = async (p: ReturnType<NearClient['send']>, label: string) => {
    const out = await p;
    if (!out.ok) throw new Error(`${label}: ${out.error}`);
    return out.txHash;
  };

  return {
    async newDepositAddress(asset: SimAsset) {
      if (asset.blockchain === 'near') {
        const kp = KeyPair.fromRandom('ed25519');
        // A NEAR implicit account id is the hex of its ed25519 public key, as 1Click returns.
        const address = bytesToHex(kp.getPublicKey().data);
        return { address, key: kp.toString() };
      }
      const secret = secp256k1.utils.randomSecretKey();
      const address = privateKeyToAccount(`0x${bytesToHex(secret)}`).address.toLowerCase();
      return { address, key: `0x${bytesToHex(secret)}` };
    },

    async depositedAmount(asset: SimAsset, address: string) {
      if (asset.blockchain === 'near') {
        const balance = await near
          .view<string>(asset.contractAddress, 'ft_balance_of', { account_id: address })
          .catch(() => '0');
        return { amount: BigInt(balance), txHashes: [] };
      }
      const token = asset.contractAddress as Hex;
      // Public RPCs refuse log queries over the whole chain. A deposit lands before its quote's
      // deadline, so recent blocks suffice; the hashes are only for display, the balance decides.
      const head = BigInt(await evm.blockNumber());
      const fromBlock = head > DEPOSIT_LOOKBACK_BLOCKS ? head - DEPOSIT_LOOKBACK_BLOCKS : 0n;
      const transfers = await evm.transfersTo(token, address as Hex, fromBlock).catch(() => []);
      return {
        amount: await evm.tokenBalance(token, address as Hex),
        txHashes: transfers.map((t) => t.txHash),
      };
    },

    async refund(asset: SimAsset, deposit, to: string, amount: bigint) {
      if (asset.blockchain === 'near') {
        await nearOk(
          near.send(solver, deposit.address, [actions.transfer(REFUND_GAS_NEAR)]),
          'fund deposit address',
        );
        const depositAccount = near.account(deposit.address, deposit.key as KeyPairString);
        return nearOk(
          near.send(depositAccount, asset.contractAddress, [
            actions.functionCall(
              'ft_transfer',
              { receiver_id: to, amount: amount.toString() },
              teraToGas(30),
              1n,
            ),
          ]),
          'refund',
        );
      }
      // One ERC-20 transfer back to the plan address, priced at the chain's current fee.
      await evm.fundGas(deposit.address as Hex, await evm.gasCostWei(SALE_GAS));
      const wallet = createWalletClient({
        account: privateKeyToAccount(deposit.key as Hex),
        chain: evm.chain,
        transport: evm.transport,
      });
      const hash = await wallet.writeContract({
        address: asset.contractAddress as Hex,
        abi: erc20Abi,
        functionName: 'transfer',
        args: [to as Hex, amount],
      });
      await evm.public.waitForTransactionReceipt({ hash });
      return hash;
    },

    async pay(asset: SimAsset, recipient: string, amount: bigint) {
      if (asset.blockchain !== 'near') throw new Error('The simulator pays out on NEAR only');
      return nearOk(
        near.call(
          solver,
          asset.contractAddress,
          'mint',
          { account_id: recipient, amount: amount.toString() },
          { deposit: 0n },
        ),
        'payout',
      );
    },
  };
}
