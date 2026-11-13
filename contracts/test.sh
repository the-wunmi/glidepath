#!/usr/bin/env bash
# Builds the wasm into res/ (the sandbox tests deploy those files), then runs every test.
set -euo pipefail

cd "$(dirname "$0")"
bash build.sh
if [ -f "$HOME/.cargo/env" ]; then
  # shellcheck disable=SC1091
  source "$HOME/.cargo/env"
fi
# One test thread, so at most one NEAR sandbox node runs at a time (several at once froze a
# laptop). Override with RUST_TEST_THREADS / CARGO_BUILD_JOBS on a bigger machine.
export CARGO_BUILD_JOBS="${CARGO_BUILD_JOBS:-2}"
export RUST_TEST_THREADS="${RUST_TEST_THREADS:-1}"
cargo test "$@"
