/**
 * Drives the Bitcoin vault prototype (contracts/btc-vault) on NEAR testnet and Bitcoin testnet4.
 *
 *   pnpm vault:demo create [--recovery <tb1…>] [--guardian <id>]… [--delay-ms N] [--path p]
 *   pnpm vault:demo status
 *   pnpm vault:demo withdraw --to <address> --amount <sats>     # owner; public, waits the delay
 *   pnpm vault:demo execute [--spend <id>]   # waits out the delay, signs, assembles, broadcasts
 *   pnpm vault:demo veto --spend <id>        # guardian
 *   pnpm vault:demo claw-back                # guardian: every UTXO to the recovery address, now
 *   pnpm vault:demo broadcast --spend <id>   # assemble a signed spend and broadcast it
 *   pnpm vault:demo run --to <address> --amount <sats>   # all of it: withdraw → wait → execute →
 *                                            # broadcast, withdraw → veto, claw-back → broadcast
 *   pnpm vault:demo --local                  # the same `run` on a throwaway NEAR sandbox with the
 *                                            # signer simulator and simulated UTXOs (no broadcast)
 *   pnpm vault:demo --local --rpc http://127.0.0.1:4420   # onto the running `pnpm dev:local`
 *                                            # sandbox, leaving deployments/local-vault.json for /labs/vault
 *
 * Testnet reads deployments/vault-testnet.json (pnpm vault:deploy). The owner signs with
 * VAULT_OWNER_* (default DEPLOY_*), guardians with VAULT_GUARDIAN_*. Every NEAR write costs testnet
 * gas; Bitcoin fees come out of the vault. VAULT_MEMPOOL_API overrides the mempool.space API.
 */

import { readFileSync } from 'node:fs';
import {
  assembleSpend,
  type ConfirmedUtxo,
  inputArgs,
  MempoolClient,
  MempoolError,
  mempoolAddressUrl,
  mempoolTxUrl,
  type PlannedSpend,
  planClawback,
  planWithdrawal,
  type SignedSpend,
  type SpendView,
  scriptForAddress,
  type VaultView,
  vaultAddress,
} from '@glidepath/btc';
import { nearSecpKey } from '@glidepath/chainsig';
import {
  type Account,
  actions,
  KeyPair,
  type KeyPairString,
  NearClient,
  SANDBOX_ROOT,
  startNearSandbox,
  teraToGas,
} from '@glidepath/near';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import { z } from 'zod';
import {
  answerSignatures,
  deployVault,
  getSpend,
  getVault,
  mpcRootKey,
  must,
  NEAR,
  readDeployment,
  step,
  type VaultDeployment,
  vaultConfig,
  wasmSha256,
  writeDeployment,
} from './lib/vault.ts';

/** Covers the storage each call adds; the contract refunds the rest. */
const CREATE_DEPOSIT = NEAR / 10n;
const WRITE_DEPOSIT = NEAR / 20n;
const VETO_DEPOSIT = NEAR / 100n;

const args = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const flags = (name: string) =>
  args.flatMap((a, i) => (a === `--${name}` && args[i + 1] ? [args[i + 1] as string] : []));
const sats = (s: bigint | string) => `${BigInt(s).toLocaleString('en-US')} sats`;
const env = Object.fromEntries(
  Object.entries(process.env).filter(([, v]) => v !== undefined && v !== ''),
);

/** The Bitcoin side: testnet4 through mempool.space, or a labelled simulation for rehearsals. */
interface BitcoinSide {
  label: string;
  utxos(address: string): Promise<ConfirmedUtxo[]>;
  /** sat/vB, at most `cap`. */
  feeRate(cap: bigint): Promise<bigint>;
  broadcast(signed: SignedSpend, spend: SpendView, vaultAddress: string): Promise<void>;
}

/**
 * VAULT_MEMPOOL_API points at another Esplora server for testnet4 (for example
 * https://blockstream.info/testnet4/api) where mempool.space itself is unreachable. Plain Esplora
 * has no fee recommendations, so there the rate is the 2 sat/vB floor (testnet4 clears at 1).
 */
function testnet4(): BitcoinSide {
  const mempool = new MempoolClient(env.VAULT_MEMPOOL_API);
  return {
    label: `Bitcoin testnet4 (${new URL(mempool.baseUrl).host})`,
    utxos: (address) => mempool.utxos(address),
    async feeRate(cap) {
      const rate = await mempool.feeRates().then(
        (f) => Math.ceil(f.halfHourFee),
        (error) => {
          if (!(error instanceof MempoolError && error.status === 404)) throw error;
          console.log('  (no fee recommendations on this server: 2 sat/vB)');
          return 2;
        },
      );
      return BigInt(Math.min(Math.max(rate, 1), Number(cap)));
    },
    async broadcast(signed, spend, vaultAddress) {
      const id = await mempool.broadcast(signed.hex);
      console.log(`  ✓ broadcast ${id}\n    ${mempoolTxUrl(id)}`);
      // The next spend may use this one's change, which the server lists only once it has indexed
      // the transaction: wait for it (a spend with no change back to the vault has nothing to wait for).
      if (BigInt(spend.change) === 0n) return;
      for (let i = 0; i < 40; i++) {
        if ((await mempool.utxos(vaultAddress)).some((u) => u.txid === id)) return;
        await new Promise((r) => setTimeout(r, 3_000));
      }
      throw new Error(`${id} was broadcast, but the server has not listed its change yet`);
    },
  };
}

/** Rehearsals only: made-up UTXOs, updated as signed spends would spend them. Never broadcast. */
function simulatedBitcoin(
  utxos: ConfirmedUtxo[] = [
    { txid: 'a1'.repeat(32), vout: 0, value: 120_000n, confirmed: true },
    { txid: 'b2'.repeat(32), vout: 1, value: 80_000n, confirmed: true },
  ],
): BitcoinSide {
  return {
    label: 'simulated UTXOs (rehearsal; nothing is broadcast)',
    utxos: async () => [...utxos],
    feeRate: async () => 2n,
    async broadcast(signed, spend) {
      for (const input of spend.inputs) {
        const i = utxos.findIndex((u) => u.txid === input.txid && u.vout === input.vout);
        if (i >= 0) utxos.splice(i, 1);
      }
      if (BigInt(spend.change) > 0n)
        utxos.push({ txid: signed.txid, vout: 1, value: BigInt(spend.change), confirmed: false });
      console.log(`  ✓ assembled ${signed.txid} (${signed.vsize} vB); simulated, not broadcast`);
    },
  };
}

interface Ctx {
  near: NearClient;
  deployment: VaultDeployment;
  owner: Account;
  guardian: Account | null;
  btc: BitcoinSide;
}

const vaultId = (ctx: Ctx) => {
  if (!ctx.deployment.vault) throw new Error('No vault yet: run `pnpm vault:demo create` first');
  return ctx.deployment.vault.id;
};
const needGuardian = (ctx: Ctx) => {
  if (!ctx.guardian)
    throw new Error('Set VAULT_GUARDIAN_ACCOUNT_ID and VAULT_GUARDIAN_PRIVATE_KEY');
  return ctx.guardian;
};

async function loadVault(ctx: Ctx): Promise<VaultView & { address: string; public_key: string }> {
  const vault = await getVault(ctx.near, ctx.deployment.contract, vaultId(ctx));
  if (!vault.address || !vault.public_key)
    throw new Error('The vault has no key yet (the signer did not answer); call refresh_key');
  return vault as VaultView & { address: string; public_key: string };
}

async function create(
  ctx: Ctx,
  recovery: string,
  guardians: string[],
  delayMs: number,
  path: string,
) {
  const { near, deployment } = ctx;
  if (deployment.vault && !args.includes('--new'))
    throw new Error(`Vault ${deployment.vault.id} already exists; pass --new to make another`);
  step(`Creating a vault on ${deployment.contract}`);
  console.log(`  owner ${ctx.owner.accountId}; guardians ${guardians.join(', ')}`);
  console.log(`  recovery ${recovery}; delay ${delayMs / 1000} s; path "${path}"`);
  const created = await must<number>(
    'create_vault',
    near.call(
      ctx.owner,
      deployment.contract,
      'create_vault',
      { guardians, recovery_address: recovery, delay_ms: delayMs, path },
      { deposit: CREATE_DEPOSIT, gasTera: 100 },
    ),
  );
  deployment.vault = {
    id: created.value,
    owner: ctx.owner.accountId,
    address: '',
    created_tx: created.txHash,
  };
  const vault = await loadVault(ctx);
  // The address must be the one anyone can derive from the MPC root key: nobody chose it.
  const derived = vaultAddress(deployment.mpc_root_public_key, deployment.contract, path);
  if (derived !== vault.address)
    throw new Error(`The contract reports ${vault.address}, derivation gives ${derived}`);
  deployment.vault.address = vault.address;
  console.log(
    `  ✓ vault #${vault.id}: ${vault.address} (matches the derivation from the root key)`,
  );
  console.log(`    ${mempoolAddressUrl(vault.address)}`);
}

async function status(ctx: Ctx) {
  const vault = await loadVault(ctx);
  const utxos = await ctx.btc.utxos(vault.address);
  const balance = utxos.reduce((s, u) => s + u.value, 0n);
  console.log(`Vault #${vault.id} on ${ctx.deployment.contract}: ${vault.address}`);
  console.log(`  ${sats(balance)} in ${utxos.length} UTXOs (${ctx.btc.label})`);
  console.log(`  owner ${vault.owner}; guardians ${vault.guardians.join(', ')}`);
  console.log(`  recovery ${vault.recovery_address}; delay ${vault.delay_ms / 1000} s`);
  const spends = await ctx.near.view<SpendView[]>(ctx.deployment.contract, 'list_spends', {
    vault_id: vault.id,
  });
  for (const s of spends)
    console.log(
      `  #${s.id} ${s.kind} ${s.status}: ${sats(s.amount)} to ${s.destination}, fee ${sats(s.fee)}, effective ${new Date(s.effective_at_ms).toISOString()}`,
    );
}

async function withdraw(ctx: Ctx, to: string, amount: bigint): Promise<number> {
  const vault = await loadVault(ctx);
  const config = await vaultConfig(ctx.near, ctx.deployment.contract);
  const utxos = (await ctx.btc.utxos(vault.address)).filter((u) => !isSigned(u));
  const rate = await ctx.btc.feeRate(BigInt(config.max_withdrawal_fee_rate_sat_vb));
  const plan = planWithdrawal(utxos, to, amount, rate, config.max_inputs);
  step(`Owner asks to send ${sats(amount)} to ${to}`);
  printPlan(plan);
  const out = await must<number>(
    'request_withdrawal',
    ctx.near.call(
      ctx.owner,
      ctx.deployment.contract,
      'request_withdrawal',
      {
        vault_id: vault.id,
        destination: to,
        amount: amount.toString(),
        inputs: inputArgs(plan.inputs),
        fee: plan.fee.toString(),
      },
      { deposit: WRITE_DEPOSIT, gasTera: 100 },
    ),
  );
  const spend = await getSpend(ctx.near, ctx.deployment.contract, vault.id, out.value);
  console.log(
    `  withdrawal #${spend.id} is public now and executable from ${new Date(spend.effective_at_ms).toISOString()}`,
  );
  return spend.id;
}

/** Outpoints already signed in this session, so a second withdrawal plans around them. */
const signedOutpoints = new Set<string>();
const isSigned = (u: { txid: string; vout: number }) => signedOutpoints.has(`${u.txid}:${u.vout}`);

function printPlan(plan: PlannedSpend) {
  for (const i of plan.inputs) console.log(`  input ${i.txid}:${i.vout} (${sats(i.amount)})`);
  console.log(`  fee ${sats(plan.fee)}; change back to the vault ${sats(plan.change)}`);
}

async function waitForDelay(ctx: Ctx, spend: SpendView) {
  for (;;) {
    const left = spend.effective_at_ms - (await ctx.near.chainTimeMs());
    if (left <= 0) return;
    console.log(`  waiting out the delay: ${Math.ceil(left / 1000)} s left`);
    await new Promise((r) => setTimeout(r, Math.min(left + 1500, 15_000)));
  }
}

async function execute(ctx: Ctx, spendId: number, caller: Account) {
  const contract = ctx.deployment.contract;
  const vault = await loadVault(ctx);
  let spend = await getSpend(ctx.near, contract, vault.id, spendId);
  if (spend.status === 'pending') {
    await waitForDelay(ctx, spend);
    step(
      `Anyone may execute #${spendId} now; the contract builds the BIP143 hashes and asks the MPC`,
    );
    await must(
      'execute',
      ctx.near.call(
        caller,
        contract,
        'execute',
        { vault_id: vault.id, spend_id: spendId },
        { deposit: WRITE_DEPOSIT, gasTera: 300 },
      ),
    );
    spend = await getSpend(ctx.near, contract, vault.id, spendId);
  }
  await broadcast(ctx, spend, vault);
}

async function broadcast(
  ctx: Ctx,
  spend: SpendView,
  vault: { address: string; public_key: string },
) {
  if (spend.status !== 'signed')
    throw new Error(`Spend #${spend.id} is ${spend.status}, not signed; execute it (again)`);
  const signed = assembleSpend(spend, vault.public_key);
  for (const i of spend.inputs) signedOutpoints.add(`${i.txid}:${i.vout}`);
  console.log(`  ✓ every signature verifies against the vault key; txid ${signed.txid}`);
  await ctx.btc.broadcast(signed, spend, vault.address);
}

async function veto(ctx: Ctx, spendId: number) {
  const guardian = needGuardian(ctx);
  step(`Guardian ${guardian.accountId} vetoes withdrawal #${spendId}`);
  await must(
    'veto',
    ctx.near.call(
      guardian,
      ctx.deployment.contract,
      'veto',
      { vault_id: vaultId(ctx), spend_id: spendId },
      { deposit: VETO_DEPOSIT, gasTera: 50 },
    ),
  );
}

async function clawBack(ctx: Ctx) {
  const guardian = needGuardian(ctx);
  const vault = await loadVault(ctx);
  const config = await vaultConfig(ctx.near, ctx.deployment.contract);
  const utxos = await ctx.btc.utxos(vault.address);
  if (!utxos.length) throw new Error('The vault holds no UTXOs to claw back');
  // Twice the usual rate (the contract also requires it to outbid any withdrawal over the same
  // coins), so the sweep can replace an executed withdrawal still in the mempool.
  const rate = (await ctx.btc.feeRate(BigInt(config.max_withdrawal_fee_rate_sat_vb))) * 2n;
  const plan = planClawback(utxos, vault.recovery_address, rate, config.max_inputs);
  step(
    `Guardian ${guardian.accountId} claws everything back to ${vault.recovery_address}, no delay`,
  );
  printPlan(plan);
  await must(
    'claw_back',
    ctx.near.call(
      guardian,
      ctx.deployment.contract,
      'claw_back',
      { vault_id: vault.id, inputs: inputArgs(plan.inputs), fee: plan.fee.toString() },
      { deposit: WRITE_DEPOSIT, gasTera: 300 },
    ),
  );
  const fresh = await loadVault(ctx);
  const spends = await ctx.near.view<SpendView[]>(ctx.deployment.contract, 'list_spends', {
    vault_id: vault.id,
    limit: 1,
  });
  const latest = spends[0];
  if (latest?.kind !== 'clawback') throw new Error('No claw-back recorded');
  await broadcast(ctx, latest, fresh);
}

/** Shows the delay holding: an execute before it ends is refused on-chain (costs a little gas). */
async function executeTooEarly(ctx: Ctx, spendId: number) {
  step(`Trying to execute #${spendId} before the delay is over`);
  const out = await ctx.near.call(
    ctx.owner,
    ctx.deployment.contract,
    'execute',
    { vault_id: vaultId(ctx), spend_id: spendId },
    { deposit: WRITE_DEPOSIT, gasTera: 300 },
  );
  if (out.ok) throw new Error('The vault executed a withdrawal before its delay');
  console.log(`  ✓ refused: ${out.error}  (tx ${out.txHash})`);
}

async function run(ctx: Ctx, to: string, amount: bigint) {
  const first = await withdraw(ctx, to, amount);
  await executeTooEarly(ctx, first);
  await execute(ctx, first, ctx.owner);
  const second = await withdraw(ctx, to, amount);
  console.log(
    '  (a thief with the owner’s key, or someone coercing the owner, could have sent that)',
  );
  await veto(ctx, second);
  await clawBack(ctx);
  await status(ctx);
}

/** The whole flow on a sandbox: the signer simulator plays the MPC network, UTXOs are simulated. */
async function rehearse() {
  const rpc = flag('rpc');
  const sandbox = rpc ? null : await startNearSandbox();
  const near = new NearClient(rpc ?? (sandbox?.rpcUrl as string));
  try {
    const root = near.account(SANDBOX_ROOT.accountId, SANDBOX_ROOT.key);
    const suffix = rpc ? `-${Date.now().toString(36)}` : '';
    const account = async (name: string, balance: bigint) => {
      const key = KeyPair.fromRandom('ed25519');
      const id = `${name}${suffix}.${SANDBOX_ROOT.accountId}`;
      await must(
        `create ${id}`,
        near.send(root, id, [
          actions.createAccount(),
          actions.transfer(balance),
          actions.addFullAccessKey(key.getPublicKey()),
        ]),
      );
      return near.account(id, key.toString() as KeyPairString);
    };
    step('Deploying the signer simulator (it plays Chain Signatures; labelled simulated)');
    const rootSecret = bytesToHex(secp256k1.utils.randomSecretKey());
    const rootPublic = nearSecpKey(
      secp256k1.Point.fromBytes(secp256k1.getPublicKey(hexToBytes(rootSecret), false)),
    );
    const signer = await account('vault-signer', 10n * NEAR);
    await must(
      'deploy signer simulator',
      near.send(signer, signer.accountId, [
        actions.deployContract(
          new Uint8Array(
            readFileSync(new URL('../contracts/res/mpc_signer_sim.wasm', import.meta.url)),
          ),
        ),
        actions.functionCall(
          'new',
          { root_public_key: rootPublic, responder: signer.accountId },
          teraToGas(30),
          0n,
        ),
      ]),
    );
    const stop = answerSignatures(near, signer.accountId, signer, rootSecret);
    try {
      const deployer = await account('vault-deployer', 20n * NEAR);
      const contract = `btc-vault.${deployer.accountId}`;
      step(`Deploying ${contract}`);
      await deployVault(near, deployer, {
        contractId: contract,
        signerId: signer.accountId,
        minDelayMs: 60_000,
        funding: 3n * NEAR,
      });
      const deployment: VaultDeployment = {
        network: 'local',
        deployed_at: new Date().toISOString(),
        rpc: near.rpcUrl,
        contract,
        signer_contract: signer.accountId,
        mpc_root_public_key: await mpcRootKey(near, signer.accountId),
        min_delay_ms: 60_000,
        wasm_sha256: wasmSha256(),
        near_spent: '0',
        vault: null,
      };
      const ctx: Ctx = {
        near,
        deployment,
        owner: await account('vault-owner', 10n * NEAR),
        guardian: await account('vault-guardian', 10n * NEAR),
        btc: simulatedBitcoin(),
      };
      // BIP173's testnet P2WSH vector: a valid address nobody here holds keys for.
      const recovery = 'tb1qrp33g0q5c5txsp9arysrx4k6zdkfs4nce4xj0gdcccefvpysxf3q0sl5k7';
      await create(ctx, recovery, [needGuardian(ctx).accountId], 60_000, 'savings');
      if (rpc) writeDeployment('local', deployment);
      // A Bitcoin address that is not the vault's: the P2TR vector from BIP350.
      await run(ctx, 'tb1pqqqqp399et2xygdj5xreqhjjvcmzhxw4aywxecjdzew6hylgvsesf3hn0c', 30_000n);
      if (rpc) {
        // A withdrawal left waiting, so the page has a live countdown to show, from a fresh
        // made-up deposit (the claw-back swept the others).
        ctx.btc = simulatedBitcoin([
          { txid: 'c3'.repeat(32), vout: 0, value: 50_000n, confirmed: true },
        ]);
        await withdraw(
          ctx,
          'tb1pqqqqp399et2xygdj5xreqhjjvcmzhxw4aywxecjdzew6hylgvsesf3hn0c',
          10_000n,
        ).catch((e: Error) => console.log(`  (no pending withdrawal left: ${e.message})`));
        console.log('\nWrote deployments/local-vault.json; open /labs/vault on the dev:local app.');
      }
      console.log(
        '\nRehearsal complete: every refusal and signature above came from the contracts.',
      );
    } finally {
      stop();
    }
  } finally {
    await sandbox?.stop();
  }
}

/** Sanity check that the recovery address is a testnet4 address before spending gas on it. */
function recoveryAddress(): string {
  const value = flag('recovery') ?? env.VAULT_RECOVERY_ADDRESS;
  if (!value) throw new Error('Pass --recovery <testnet4 address> or set VAULT_RECOVERY_ADDRESS');
  if (!scriptForAddress(value)) throw new Error(`Not a testnet4 address: ${value}`);
  return value;
}

async function main() {
  if (args.includes('--local')) return rehearse();
  const command = args[0];
  const deployment = readDeployment('testnet');
  if (!deployment)
    throw new Error('No deployments/vault-testnet.json: run pnpm vault:deploy --confirm');
  const Creds = z.object({
    DEPLOY_ACCOUNT_ID: z.string().regex(/\.testnet$/, 'Use a .testnet account'),
    DEPLOY_PRIVATE_KEY: z.string().startsWith('ed25519:'),
    VAULT_OWNER_ACCOUNT_ID: z
      .string()
      .regex(/\.testnet$/)
      .optional(),
    VAULT_OWNER_PRIVATE_KEY: z.string().startsWith('ed25519:').optional(),
    VAULT_GUARDIAN_ACCOUNT_ID: z
      .string()
      .regex(/\.testnet$/)
      .optional(),
    VAULT_GUARDIAN_PRIVATE_KEY: z.string().startsWith('ed25519:').optional(),
  });
  const c = Creds.parse(env);
  const near = new NearClient(deployment.rpc);
  const ctx: Ctx = {
    near,
    deployment,
    owner: near.account(
      c.VAULT_OWNER_ACCOUNT_ID ?? c.DEPLOY_ACCOUNT_ID,
      (c.VAULT_OWNER_PRIVATE_KEY ?? c.DEPLOY_PRIVATE_KEY) as KeyPairString,
    ),
    guardian:
      c.VAULT_GUARDIAN_ACCOUNT_ID && c.VAULT_GUARDIAN_PRIVATE_KEY
        ? near.account(c.VAULT_GUARDIAN_ACCOUNT_ID, c.VAULT_GUARDIAN_PRIVATE_KEY as KeyPairString)
        : null,
    btc: testnet4(),
  };
  const spendId = () => {
    const id = Number(flag('spend'));
    if (!Number.isInteger(id) || id <= 0) throw new Error('Pass --spend <id>');
    return id;
  };
  const target = () => {
    const to = flag('to');
    const amount = flag('amount');
    if (!to || !amount) throw new Error('Pass --to <testnet4 address> --amount <sats>');
    return [to, BigInt(amount)] as const;
  };
  switch (command) {
    case 'create': {
      const guardians = flags('guardian');
      if (!guardians.length && c.VAULT_GUARDIAN_ACCOUNT_ID)
        guardians.push(c.VAULT_GUARDIAN_ACCOUNT_ID);
      if (!guardians.length)
        throw new Error('Pass --guardian <account> or set VAULT_GUARDIAN_ACCOUNT_ID');
      await create(
        ctx,
        recoveryAddress(),
        guardians,
        Number(flag('delay-ms') ?? deployment.min_delay_ms),
        flag('path') ?? 'savings',
      );
      writeDeployment('testnet', deployment);
      console.log(
        '\nFund the address above from a testnet4 faucet, then run `pnpm vault:demo status`.',
      );
      return;
    }
    case 'status':
      return status(ctx);
    case 'withdraw':
      await withdraw(ctx, ...target());
      return;
    case 'execute': {
      const vault = await loadVault(ctx);
      const id = flag('spend') ? spendId() : vault.open_withdrawal;
      if (!id) throw new Error('No open withdrawal; pass --spend <id>');
      return execute(ctx, id, ctx.owner);
    }
    case 'veto':
      return veto(ctx, spendId());
    case 'claw-back':
      return clawBack(ctx);
    case 'broadcast': {
      const vault = await loadVault(ctx);
      return broadcast(ctx, await getSpend(near, deployment.contract, vault.id, spendId()), vault);
    }
    case 'run':
      return run(ctx, ...target());
    default:
      throw new Error(
        'Commands: create, status, withdraw, execute, veto, claw-back, broadcast, run (or --local)',
      );
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
