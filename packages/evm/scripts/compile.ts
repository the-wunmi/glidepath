import { readFileSync, writeFileSync } from 'node:fs';
import solc from 'solc';

/** Compiles LaunchToken.sol into src/launch-token.json. Rerun only when the Solidity changes. */
const source = readFileSync(new URL('../contracts/LaunchToken.sol', import.meta.url), 'utf8');
const input = {
  language: 'Solidity',
  sources: { 'LaunchToken.sol': { content: source } },
  settings: {
    optimizer: { enabled: true, runs: 200 },
    evmVersion: 'cancun',
    outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } },
  },
};
const output = JSON.parse(solc.compile(JSON.stringify(input)));
const errors = (output.errors ?? []).filter((e: { severity: string }) => e.severity === 'error');
if (errors.length) throw new Error(JSON.stringify(errors, null, 2));
const contract = output.contracts['LaunchToken.sol'].LaunchToken;
writeFileSync(
  new URL('../src/launch-token.json', import.meta.url),
  `${JSON.stringify({ compiler: solc.version(), abi: contract.abi, bytecode: `0x${contract.evm.bytecode.object}` }, null, 2)}\n`,
);
console.log('compiled LaunchToken with solc', solc.version());
