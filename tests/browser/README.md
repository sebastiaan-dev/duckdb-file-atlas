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

Fixtures are generated checksum-valid v69 files uploaded through the real file
input and decoded by the application's inspection worker. The semantic-selection
case uses the supported manifest fallback with unsupported catalog metadata.
Tests drive actual pointer coordinates, keyboard focus, selections and paging.
Race tests hold/release the browser's real 64-byte Blob reads to deterministically
complete old reads after newer selections/file uploads, without timing sleeps or
application-specific test hooks.

Failure traces and diagnostics are saved under
`node_modules/.cache/playwright-results`. To inspect a trace:

```sh
bunx playwright show-trace node_modules/.cache/playwright-results/<test>/trace.zip
```
