# Chromium UI regressions

```sh
bun install
bunx playwright install chromium
bun run test:browser
```

This opt-in suite uses Playwright's Chromium browser and starts/stops its own Vite
server on `127.0.0.1:5183` (the port must be free). `bun test` remains the fast unit
suite and does not discover the `*.e2e.ts` files. No DuckDB binary, existing dev
server, external service, or checked-in binary database is required.

Fixtures are generated checksum-valid files uploaded through the real file
input and decoded by the application's inspection worker. The semantic-selection
case uses the supported manifest fallback with unsupported catalog metadata.
Tests drive actual pointer coordinates, keyboard focus, selections and paging.

The real in-browser TPC-H generation test is opt-in because it downloads the
pinned WASM runtime and extension. Run it with network access:

```sh
TPCH_BROWSER_NETWORK=1 bun run test:browser
```

It exports and downloads a real file, checks its headers, and opens it through
the application's native decoder, asserting all eight tables are present.
Offline tests exercise cancellation/retry and failed worker startup using
blocked network routes. The runtime must not download just by opening the app.

Native release compatibility is tested separately against real CLI writers:

```sh
DUCKDB_COMPAT_BINS="/path/to/1.4.5/duckdb:/path/to/1.5.6/duckdb" bun test tests/compatibility.integration.test.ts
```

Use your OS's PATH delimiter (colon on Unix, semicolon on Windows). Tests create
files in default and explicit supported formats, verify live rows and physical
segment pointers/counts/compression against SQL, and confirm inspection leaves
file bytes unchanged. No extensions or external datasets are required.
Race tests hold/release the browser's real 64-byte Blob reads to deterministically
complete old reads after newer selections/file uploads, without timing sleeps or
application-specific test hooks.

Failure traces and diagnostics are saved under
`node_modules/.cache/playwright-results`. To inspect a trace:

```sh
bunx playwright show-trace node_modules/.cache/playwright-results/<test>/trace.zip
```
