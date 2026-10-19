# Vendored DuckDB-WASM 1.33.1-dev107.0

DuckDB-WASM built from DuckDB v2.0.0-dev88537 (source `f8f3f4dcd9`) by
duckdb-wasm CI run <https://github.com/duckdb/duckdb-wasm/actions/runs/39224314730>
(loadable-extension variant). Published DuckDB-WASM packages cannot write
`STORAGE_VERSION 'v2.0.0'` yet; the TPC-H generator needs a DuckDB 2.0 build.

Only the JS API lives here. The WASM module, worker and extensions are
release assets of this repository (`duckdb-wasm-1.33.1-dev107.0`), listed with checksums in
`runtime.json` and fetched by `scripts/fetch-duckdb-runtime.ts`.

Regenerate with `bun scripts/vendor-duckdb-wasm.ts <run id> --publish`.
DuckDB and DuckDB-WASM are MIT licensed; see LICENSE.
