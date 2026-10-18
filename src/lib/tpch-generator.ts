import type { AsyncDuckDB } from "@duckdb/duckdb-wasm";

export const TPCH_WASM_VERSION = "1.33.1-dev65.0";
export const TPCH_SCALE_FACTORS = [0.01, 0.1] as const;
export type TpchScaleFactor = (typeof TPCH_SCALE_FACTORS)[number];

export interface TpchGenerationOptions {
  scaleFactor?: TpchScaleFactor;
  signal?: AbortSignal;
  /** Stage descriptions, not an estimated percentage of dbgen's work. */
  onProgress?: (message: string) => void;
}

/** Keep the JS API, worker and WASM versions in sync. No deployment-root paths. */
const CDN = `https://cdn.jsdelivr.net/npm/@duckdb/duckdb-wasm@${TPCH_WASM_VERSION}/dist/`;
const FILE_NAME = "tpch.duckdb";

export function tpchGenerationError(error: unknown): string {
  const detail = error instanceof Error ? error.message : String(error);
  return `TPC-H generation failed. Check your connection and allow downloads from cdn.jsdelivr.net and extensions.duckdb.org (including Blob workers in your site's content security policy). If memory is limited, use SF 0.01 or close other tabs and retry.${detail ? ` Details: ${detail}` : ""}`;
}

/**
 * Generate a real, checkpointed DuckDB file entirely in an isolated worker.
 * Nothing is uploaded. The runtime and TPC-H extension are downloaded only here,
 * after the caller explicitly starts generation. Single-threaded bundles avoid
 * requiring cross-origin isolation / SharedArrayBuffer on static hosting.
 */
export async function generateTpchDatabase({
  scaleFactor = 0.01,
  signal,
  onProgress,
}: TpchGenerationOptions = {}): Promise<File> {
  // Runtime validation matters even though TypeScript callers get a narrow type.
  if (!TPCH_SCALE_FACTORS.includes(scaleFactor)) {
    throw new Error("Choose TPC-H scale factor 0.01 or 0.1.");
  }
  signal?.throwIfAborted();

  let worker: Worker | undefined;
  let workerURL: string | undefined;
  let db: AsyncDuckDB | undefined;
  let stop!: (reason: unknown) => void;
  const stopped = new Promise<never>((_, reject) => {
    stop = reject;
  });
  // Worker termination does not reject DuckDB-WASM's outstanding requests.
  // Race each request so cancellation / worker startup errors cannot hang UI.
  const wait = <T>(operation: Promise<T>): Promise<T> =>
    Promise.race([operation, stopped]);
  const abort = () => {
    worker?.terminate();
    stop(new DOMException("TPC-H generation cancelled.", "AbortError"));
  };
  const workerError = (event: ErrorEvent) =>
    stop(new Error(event.message || "DuckDB worker failed to start."));
  const messageError = () =>
    stop(new Error("Could not receive data from the DuckDB worker."));
  signal?.addEventListener("abort", abort, { once: true });
  const timeout = setTimeout(
    () => {
      worker?.terminate();
      stop(
        new Error(
          "Generation timed out after five minutes. Retry with SF 0.01.",
        ),
      );
    },
    5 * 60 * 1000,
  );

  try {
    onProgress?.("Downloading DuckDB runtime…");
    const duckdb = await wait(import("@duckdb/duckdb-wasm"));
    const bundle = await wait(
      duckdb.selectBundle({
        mvp: {
          mainModule: `${CDN}duckdb-mvp.wasm`,
          mainWorker: `${CDN}duckdb-browser-mvp.worker.js`,
        },
        eh: {
          mainModule: `${CDN}duckdb-eh.wasm`,
          mainWorker: `${CDN}duckdb-browser-eh.worker.js`,
        },
      }),
    );
    // A CDN URL cannot be used directly as a Worker URL across origins.
    workerURL = URL.createObjectURL(
      new Blob([`importScripts(${JSON.stringify(bundle.mainWorker)});`], {
        type: "text/javascript",
      }),
    );
    worker = new Worker(workerURL);
    worker.addEventListener("error", workerError);
    worker.addEventListener("messageerror", messageError);
    db = new duckdb.AsyncDuckDB(new duckdb.VoidLogger(), worker);
    await wait(db.instantiate(bundle.mainModule));
    // Required for reliable export of ATTACH-created files with this WASM build.
    // The default buffered filesystem can fail in copyFileToBuffer otherwise.
    await wait(
      db.open({ path: ":memory:", useDirectIO: true, maximumThreads: 1 }),
    );
    const connection = await wait(db.connect());
    await wait(connection.query("SET memory_limit = '512MB'"));
    onProgress?.("Downloading and loading the TPC-H extension…");
    await wait(
      connection.query(
        "SET custom_extension_repository = 'https://extensions.duckdb.org'",
      ),
    );
    await wait(connection.query("INSTALL tpch"));
    await wait(connection.query("LOAD tpch"));
    await wait(
      connection.query(
        `ATTACH '${FILE_NAME}' AS generated (STORAGE_VERSION 'v1.5.0')`,
      ),
    );
    onProgress?.(`Generating TPC-H tables (SF ${scaleFactor})…`);
    await wait(
      connection.query(
        `CALL dbgen(sf = ${scaleFactor}, catalog = 'generated')`,
      ),
    );
    onProgress?.("Checkpointing the database file…");
    await wait(connection.query("CHECKPOINT generated"));
    await wait(connection.query("DETACH generated"));
    await wait(connection.close());
    onProgress?.("Preparing the .duckdb file…");
    const bytes = await wait(db.copyFileToBuffer(FILE_NAME));
    if (
      bytes.length < 12288 ||
      new TextDecoder().decode(bytes.subarray(8, 12)) !== "DUCK"
    ) {
      throw new Error("DuckDB did not produce a complete database file.");
    }
    // Own the ArrayBuffer explicitly (also avoids SharedArrayBuffer Blob typing).
    return new File([new Uint8Array(bytes)], `tpch-sf${scaleFactor}.duckdb`, {
      type: "application/octet-stream",
    });
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", abort);
    // No cleanup SQL: that could hang behind dbgen when cancelling. Termination
    // releases the worker's entire in-memory filesystem on every exit path.
    db?.detach();
    worker?.removeEventListener("error", workerError);
    worker?.removeEventListener("messageerror", messageError);
    worker?.terminate();
    if (workerURL) URL.revokeObjectURL(workerURL);
  }
}
