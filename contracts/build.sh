#!/usr/bin/env bash
# Builds every contract to wasm with cargo-near and copies the results to res/, which the
# integration tests (and the TypeScript side) load. Run from anywhere.
set -euo pipefail

cd "$(dirname "$0")"
if [ -f "$HOME/.cargo/env" ]; then
  # shellcheck disable=SC1091
  source "$HOME/.cargo/env"
fi

# Two compile jobs keep the machine responsive; override with CARGO_BUILD_JOBS if it can take more.
export CARGO_BUILD_JOBS="${CARGO_BUILD_JOBS:-2}"

mkdir -p res
for crate in plan-account mpc-signer-sim demo-token plan-registry btc-vault blind-trust; do
  echo "building ${crate}"
  cargo near build non-reproducible-wasm --no-abi \
    --manifest-path "${crate}/Cargo.toml" --out-dir res
done

(cd res && shasum -a 256 plan_registry.wasm plan_account.wasm mpc_signer_sim.wasm demo_token.wasm btc_vault.wasm blind_trust.wasm > SHA256SUMS)
cat res/SHA256SUMS
ls -l res/*.wasm
