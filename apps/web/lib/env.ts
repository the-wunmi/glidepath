import type { Meta } from './types';

/**
 * Facts about where this server runs, worded for people: chain names, explorer links and why a
 * part is simulated. Everything comes from /api/meta, so the same build reads true on a local
 * chain and on testnet.
 */

/** Block explorers by EVM chain id. Local chains have none. */
const EVM_EXPLORERS: Record<number, { name: string; url: string }> = {
  11155111: { name: 'Sepolia', url: 'https://sepolia.etherscan.io' },
};

const NEAR_EXPLORERS: Record<Meta['network'], string | null> = {
  testnet: 'https://testnet.nearblocks.io',
  local: null,
};

/** "Sepolia", or "the local EVM chain" when the server runs its own node. */
export function evmChainName(meta: Meta | null): string {
  if (meta?.modes.evm !== 'live') return 'the local EVM chain';
  return EVM_EXPLORERS[meta.evmChainId]?.name ?? `EVM chain ${meta.evmChainId}`;
}

export const nearChainName = (meta: Meta | null) =>
  meta?.network === 'testnet' ? 'NEAR testnet' : 'the local NEAR chain';

export interface Explorer {
  nearTx: (hash: string) => string | undefined;
  nearAccount: (account: string) => string | undefined;
  evmTx: (hash: string) => string | undefined;
  evmAddress: (address: string) => string | undefined;
}

/** Links into public explorers; undefined where the chain is local and has none. */
export function explorer(meta: Meta | null): Explorer {
  const near = meta ? NEAR_EXPLORERS[meta.network] : null;
  const evm = meta && meta.modes.evm === 'live' ? EVM_EXPLORERS[meta.evmChainId]?.url : undefined;
  return {
    nearTx: (h) => (near ? `${near}/txns/${h}` : undefined),
    nearAccount: (a) => (near ? `${near}/address/${a}` : undefined),
    evmTx: (h) => (evm ? `${evm}/tx/${h}` : undefined),
    evmAddress: (a) => (evm ? `${evm}/address/${a}` : undefined),
  };
}

/** Why each simulated part is simulated, said once wherever it is used. */
const SIM_REASONS = {
  enclave: 'this server runs the local stand-in; the live site uses OutLayer’s TDX workers',
  oneclick: '1Click has no testnet',
  chainSignatures: 'a stand-in signer on the local chain',
} as const;

export type SimulatedPart = keyof typeof SIM_REASONS;

/** The reason a part is simulated on this server, or null when it runs for real. */
export const simReason = (meta: Meta | null, part: SimulatedPart): string | null =>
  meta && meta.modes[part] === 'mock' ? SIM_REASONS[part] : null;

/** True when anything outside is simulated: the demo controls exist only then. */
export const hasSimulatedParts = (meta: Meta | null) =>
  !!meta && Object.values(meta.modes).some((m) => m === 'mock');
