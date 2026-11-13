import { type ChildProcess, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  type Abi,
  type Chain,
  concat,
  createPublicClient,
  createWalletClient,
  defineChain,
  erc20Abi,
  fallback,
  type Hex,
  http,
  keccak256,
  type PublicClient,
  parseEventLogs,
  type Transport,
  toHex,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import artifact from './launch-token.json' with { type: 'json' };

export const LAUNCH_TOKEN_ABI = artifact.abi as Abi;

/**
 * Hardhat's first default account. Its key is published in Hardhat's docs and only ever funds the
 * local test chain; live mode never uses it.
 */
export const LOCAL_FUNDER_KEY: Hex =
  '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';

/**
 * Hardhat's third default account, the local launchpad: it only deploys tokens, so its next nonce,
 * and with it the next token address, is known in advance.
 */
export const LOCAL_LAUNCHPAD_KEY: Hex =
  '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a';

export const SEPOLIA_CHAIN_ID = 11155111;

/** An ERC-20 transfer to a new holder measured 142k gas on Sepolia; the registry signs a 150k cap. */
export const SALE_GAS = 150_000n;
/** A launch-token deployment measured about 1.2M gas. */
export const DEPLOY_GAS = 1_300_000n;
/** A plan address is funded for at most this many sales up front; nothing tops it up later. */
const MAX_FUNDED_SALES = 20;
/** Bounds on a Sepolia plan's gas allowance: the floor covers a fee spike, the cap is the old flat 0.01 ETH. */
const MIN_GAS_ALLOWANCE_WEI = 10n ** 15n;
const MAX_GAS_ALLOWANCE_WEI = 10n ** 16n;

/**
 * On a public chain the launchpad is derived from the funder key, so one secret in .env covers
 * both, and the launchpad still sends nothing but token deployments.
 */
export const launchpadKeyFor = (funderKey: Hex): Hex =>
  keccak256(concat([funderKey, toHex('glidepath/launchpad')]));

export const localChain = (rpcUrl: string, chainId = 31337): Chain =>
  defineChain({
    id: chainId,
    name: chainId === SEPOLIA_CHAIN_ID ? 'Sepolia' : 'Local EVM',
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl] } },
  });

export interface EvmNode {
  rpcUrl: string;
  stop: () => Promise<void>;
}

/** Starts a Hardhat node (chain 31337) on the given port and waits until it answers RPC. */
export async function startEvmNode(port: number): Promise<EvmNode> {
  const cwd = fileURLToPath(new URL('..', import.meta.url));
  const bin = fileURLToPath(new URL('../node_modules/.bin/hardhat', import.meta.url));
  const child: ChildProcess = spawn(bin, ['node', '--port', String(port)], {
    cwd,
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let stderr = '';
  child.stderr?.on('data', (d) => {
    stderr = (stderr + String(d)).slice(-2000);
  });
  const rpcUrl = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 60_000;
  for (;;) {
    if (child.exitCode !== null) throw new Error(`EVM node exited: ${stderr}`);
    try {
      const res = await fetch(rpcUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] }),
      });
      if (res.ok) break;
    } catch {
      // not listening yet
    }
    if (Date.now() > deadline) throw new Error('EVM node did not start within 60 s');
    await new Promise((r) => setTimeout(r, 300));
  }
  return {
    rpcUrl,
    stop: async () => {
      if (child.exitCode !== null) return;
      const exited = new Promise((r) => child.once('exit', r));
      child.kill('SIGTERM');
      // Hardhat can ignore SIGTERM while busy; it holds no state worth a clean shutdown.
      const timer = setTimeout(() => child.kill('SIGKILL'), 5_000);
      await exited;
      clearTimeout(timer);
    },
  };
}

/** Everything the app does on an EVM chain: deploy the launch token, read balances, broadcast. */
export class EvmClient {
  readonly chain: Chain;
  readonly public: PublicClient;
  /** The primary RPC, then any fallbacks: public Sepolia endpoints rate-limit bursts. */
  readonly transport: Transport;
  readonly launchpadKey: Hex;
  /** Local ETH is free, so local amounts are generous; Sepolia's come from a faucet. */
  readonly local: boolean;
  private readonly receiptTimeoutMs: number;

  constructor(
    readonly rpcUrl: string,
    chainId: number,
    private readonly funderKey: Hex,
    options: { fallbackUrls?: string[]; launchpadKey?: Hex } = {},
  ) {
    this.chain = localChain(rpcUrl, chainId);
    const urls = [rpcUrl, ...(options.fallbackUrls ?? [])];
    this.transport =
      urls.length > 1
        ? fallback(urls.map((u) => http(u, { retryCount: 2 })))
        : http(rpcUrl, { retryCount: 2 });
    this.public = createPublicClient({ chain: this.chain, transport: this.transport });
    this.launchpadKey = options.launchpadKey ?? LOCAL_LAUNCHPAD_KEY;
    this.local = chainId !== SEPOLIA_CHAIN_ID;
    // Sepolia makes a block every 12 s and can take several to include a transaction.
    this.receiptTimeoutMs = this.local ? 30_000 : 180_000;
  }

  /** The account that pays for deployments and gas allowances. */
  get funderAddress(): Hex {
    return privateKeyToAccount(this.funderKey).address;
  }

  /**
   * Wei for `gas` at twice the chain's current max fee: room for the base fee to rise and for the
   * registry's re-signs, each at least 12.5% dearer.
   */
  async gasCostWei(gas: bigint): Promise<bigint> {
    return gas * (await this.fees()).maxFeePerGas * 2n;
  }

  /** ETH given to a plan's Chain Signatures address for the gas of its expected sales. */
  async gasAllowanceWei(expectedSales: number): Promise<bigint> {
    if (this.local) return 10n ** 18n;
    const sales = BigInt(Math.min(Math.max(expectedSales, 1), MAX_FUNDED_SALES));
    const want = await this.gasCostWei(SALE_GAS * sales);
    if (want < MIN_GAS_ALLOWANCE_WEI) return MIN_GAS_ALLOWANCE_WEI;
    if (want > MAX_GAS_ALLOWANCE_WEI) return MAX_GAS_ALLOWANCE_WEI;
    return want;
  }

  private wallet() {
    return createWalletClient({
      account: privateKeyToAccount(this.funderKey),
      chain: this.chain,
      transport: this.transport,
    });
  }

  /** Tops an address up from the funder when it holds less than `min`. */
  async ensureBalance(to: Hex, min: bigint, topUp: bigint): Promise<void> {
    if ((await this.ethBalance(to)) < min) await this.fundGas(to, topUp);
  }

  /** Deploys a token whose constructor mints each allocation, e.g. the team's into a plan address. */
  async deployLaunchToken(
    name: string,
    symbol: string,
    allocations: { holder: Hex; amount: bigint }[],
  ): Promise<Hex> {
    const hash = await this.wallet().deployContract({
      abi: LAUNCH_TOKEN_ABI,
      bytecode: artifact.bytecode as Hex,
      args: [name, symbol, allocations.map((a) => a.holder), allocations.map((a) => a.amount)],
    });
    const receipt = await this.public.waitForTransactionReceipt({ hash });
    if (!receipt.contractAddress) throw new Error('Token deployment produced no address');
    return receipt.contractAddress.toLowerCase() as Hex;
  }

  /** Same as deployLaunchToken, from a dedicated deployer so the address is predictable. */
  async deployLaunchTokenFrom(
    deployerKey: Hex,
    name: string,
    symbol: string,
    allocations: { holder: Hex; amount: bigint }[],
  ): Promise<{ address: Hex; txHash: Hex }> {
    const wallet = createWalletClient({
      account: privateKeyToAccount(deployerKey),
      chain: this.chain,
      transport: this.transport,
    });
    const txHash = await wallet.deployContract({
      abi: LAUNCH_TOKEN_ABI,
      bytecode: artifact.bytecode as Hex,
      args: [name, symbol, allocations.map((a) => a.holder), allocations.map((a) => a.amount)],
    });
    const receipt = await this.public.waitForTransactionReceipt({
      hash: txHash,
      timeout: this.receiptTimeoutMs,
    });
    if (!receipt.contractAddress) throw new Error('Token deployment produced no address');
    return { address: receipt.contractAddress.toLowerCase() as Hex, txHash };
  }

  /** Sends ETH for gas to an address the MPC network controls. */
  async fundGas(to: Hex, wei: bigint): Promise<void> {
    const hash = await this.wallet().sendTransaction({ to, value: wei });
    await this.public.waitForTransactionReceipt({ hash, timeout: this.receiptTimeoutMs });
  }

  async transferToken(token: Hex, to: Hex, amount: bigint): Promise<Hex> {
    const hash = await this.wallet().writeContract({
      address: token,
      abi: erc20Abi,
      functionName: 'transfer',
      args: [to, amount],
    });
    await this.public.waitForTransactionReceipt({ hash });
    return hash;
  }

  tokenBalance(token: Hex, holder: Hex): Promise<bigint> {
    return this.public.readContract({
      address: token,
      abi: erc20Abi,
      functionName: 'balanceOf',
      args: [holder],
    });
  }

  async hasCode(address: Hex): Promise<boolean> {
    const code = await this.public.getCode({ address });
    return !!code && code !== '0x';
  }

  ethBalance(holder: Hex): Promise<bigint> {
    return this.public.getBalance({ address: holder });
  }

  nonceOf(holder: Hex): Promise<number> {
    return this.public.getTransactionCount({ address: holder, blockTag: 'pending' });
  }

  async fees(): Promise<{ maxFeePerGas: bigint; maxPriorityFeePerGas: bigint }> {
    const fees = await this.public.estimateFeesPerGas();
    return { maxFeePerGas: fees.maxFeePerGas, maxPriorityFeePerGas: fees.maxPriorityFeePerGas };
  }

  /**
   * Broadcasts an already-signed transaction. Anyone may do this; the hash is known before
   * broadcast, so a resend after a crash is harmless (the node reports it as already known).
   */
  async broadcast(signed: Hex): Promise<{ hash: Hex; status: 'success' | 'reverted' }> {
    let hash: Hex;
    try {
      hash = await this.public.sendRawTransaction({ serializedTransaction: signed });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!/already known|nonce too low/i.test(message)) throw error;
      hash = keccak256(signed);
    }
    const receipt = await this.public.waitForTransactionReceipt({
      hash,
      timeout: this.receiptTimeoutMs,
    });
    return { hash, status: receipt.status };
  }

  /**
   * Sends an already-signed transaction without waiting for it to be mined. A resend of the same
   * bytes is harmless: the node reports it as known and the hash is the same.
   */
  async send(signed: Hex): Promise<Hex> {
    try {
      return await this.public.sendRawTransaction({ serializedTransaction: signed });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!/already known|nonce too low|known transaction/i.test(message)) throw error;
      return keccak256(signed);
    }
  }

  /** The receipt of a mined transaction, or null while it is pending (or unknown). */
  async receiptOf(hash: Hex): Promise<{ status: 'success' | 'reverted' } | null> {
    const receipt = await this.public.getTransactionReceipt({ hash }).catch(() => null);
    return receipt ? { status: receipt.status } : null;
  }

  async blockNumber(): Promise<number> {
    return Number(await this.public.getBlockNumber());
  }

  /** ERC-20 transfers into an address since a block, used to detect 1Click deposits. */
  async transfersTo(token: Hex, to: Hex, fromBlock: bigint) {
    const logs = await this.public.getLogs({ address: token, fromBlock });
    const transfers = parseEventLogs({ abi: erc20Abi, logs, eventName: 'Transfer' });
    return transfers
      .filter((l) => l.args.to.toLowerCase() === to.toLowerCase())
      .map((l) => ({
        txHash: l.transactionHash,
        from: l.args.from.toLowerCase() as Hex,
        amount: l.args.value,
        blockNumber: l.blockNumber,
      }));
  }
}
