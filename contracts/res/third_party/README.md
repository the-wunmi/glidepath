# Third-party contract binaries

- `sputnikdao2.wasm`: Sputnik DAO v2, exactly the code the mainnet factory `sputnik-dao.near` deploys today
  (`get_default_code_hash` = `DtHZA1mUmGYeScEaUoUZYQGGFHSMpnjMCvkr5U9hJXuF`, sha256 hex
  `bf6f951ee5e45968e3367fa857bebf8bc80badec183998c2239c487237e0d7f6`). The GitHub repo
  https://github.com/near-daos/sputnik-dao-contract publishes no release wasm for sputnikdao2, so it was
  fetched on 2026-11-11 with the view call `sputnik-dao.near.get_code({"code_hash":"DtHZA1mU..."})` on
  mainnet RPC and its base58 sha256 checked against that code hash. Source and license: MIT,
  https://github.com/near-daos/sputnik-dao-contract (LICENSE). Used only by the integration tests.
