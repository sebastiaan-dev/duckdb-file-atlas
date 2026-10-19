import type { AsyncDuckDB } from "@duckdb/duckdb-wasm";
import runtime from "../../vendor/duckdb-wasm/runtime.json";
import { findFile, opfsRoot, removeMatching, scratchDirectories } from "./opfs";

/** The vendored DuckDB 2.0 build; see vendor/duckdb-wasm/README.md. */
export const TPCH_WASM_VERSION = runtime.package;
export const TPCH_DUCKDB_VERSION = runtime.duckdb;
/** Generated files use the newest storage format this app inspects fully. */
export const TPCH_STORAGE_VERSION = "v2.0.0";
export const TPCH_SCALE_FACTORS = [0.01, 0.1, 1] as const;
export type TpchScaleFactor = (typeof TPCH_SCALE_FACTORS)[number];
export const DEFAULT_TPCH_SCALE_FACTOR: TpchScaleFactor = 1;

export interface TpchGenerationOptions {
  scaleFactor?: TpchScaleFactor;
  signal?: AbortSignal;
  /** Stage descriptions, not an estimated percentage of dbgen's work. */
  onProgress?: (message: string) => void;
}

/** Prefix of the OPFS files a generation writes; leftovers are swept. */
const FILE_PREFIX = "atlas-tpch-";
const isGeneratedFile = (name: string) =>
  name.startsWith(FILE_PREFIX) && /\.duckdb(\.wal)?$/.test(name);

/**
 * Same-origin runtime directory, installed by scripts/fetch-duckdb-runtime.ts.
 * Resolved against the page so the app also works under a deployment subpath.
 */
export function tpchRuntimeURL(path = "") {
  return new URL(
    `${import.meta.env?.BASE_URL ?? "/"}duckdb-runtime/${runtime.sourceId}/${path}`,
    globalThis.location?.href ?? "http://localhost/",
  ).href;
}

export function tpchGenerationError(error: unknown): string {
  const detail = error instanceof Error ? error.message : String(error);
  return `TPC-H generation failed. The DuckDB runtime (about 35 MB) is served by this site; check your connection and retry. If memory is limited, use SF 0.01 or close other tabs.${detail ? ` Details: ${detail}` : ""}`;
}

/**
 * Generate a real, checkpointed DuckDB file entirely in an isolated worker.
 * Nothing is uploaded. The runtime and TPC-H extension are fetched from this
 * site only here, after the caller explicitly starts generation.
 */
export async function generateTpchDatabase({
  scaleFactor = DEFAULT_TPCH_SCALE_FACTOR,
  signal,
  onProgress,
}: TpchGenerationOptions = {}): Promise<File> {
  // Runtime validation matters even though TypeScript callers get a narrow type.
  if (!TPCH_SCALE_FACTORS.includes(scaleFactor)) {
    throw new Error("Choose TPC-H scale factor 0.01, 0.1 or 1.");
  }
  signal?.throwIfAborted();

  let worker: Worker | undefined;
  let db: AsyncDuckDB | undefined;
  // The database is written to OPFS and read back once the worker is gone:
  // this DuckDB 2.0 build keeps detached files locked, so the in-memory
  // filesystem cannot export them, and OPFS also keeps them off the heap.
  const fileName = `${FILE_PREFIX}${crypto.randomUUID()}.duckdb`;
  let root: FileSystemDirectoryHandle | undefined;
  let scratchBefore = new Set<string>();
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
    root = await wait(opfsRoot());
    // Sweep files of earlier runs that were interrupted (e.g. a closed tab).
    await wait(removeMatching(root, isGeneratedFile));
    scratchBefore = await wait(scratchDirectories(root));
    onProgress?.("Downloading DuckDB runtime…");
    const duckdb = await wait(import("@duckdb/duckdb-wasm"));
    // Only the single-threaded bundle is vendored: threads need cross-origin
    // isolation, which static hosting cannot provide.
    const bundle = await wait(
      duckdb.selectBundle({
        base: {
          mainModule: tpchRuntimeURL("duckdb-base.wasm"),
          mainWorker: tpchRuntimeURL("duckdb-browser-base.worker.js"),
        },
      }),
    );
    worker = new Worker(bundle.mainWorker!);
    worker.addEventListener("error", workerError);
    worker.addEventListener("messageerror", messageError);
    db = new duckdb.AsyncDuckDB(new duckdb.VoidLogger(), worker);
    await wait(db.instantiate(bundle.mainModule));
    await wait(
      db.open({
        path: ":memory:",
        maximumThreads: 1,
        // The vendored CI build ships an unsigned TPC-H extension, served
        // from this site next to the runtime it was built with.
        allowUnsignedExtensions: true,
        // Let `opfs://` paths open OPFS access handles inside the worker.
        opfs: { fileHandling: "auto" },
      }),
    );
    const connection = await wait(db.connect());
    await wait(connection.query("SET memory_limit = '512MB'"));
    onProgress?.("Downloading and loading the TPC-H extension…");
    await wait(
      connection.query(
        `SET custom_extension_repository = '${tpchRuntimeURL("extensions")}'`,
      ),
    );
    await wait(connection.query("INSTALL tpch"));
    await wait(connection.query("LOAD tpch"));
    await wait(
      connection.query(
        `ATTACH 'opfs://${fileName}' AS generated (STORAGE_VERSION '${TPCH_STORAGE_VERSION}')`,
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
    // Terminating the worker closes its OPFS access handles.
    db.detach();
    db = undefined;
    worker.terminate();
    const handle = await wait(findFile(root, fileName));
    if (!handle) throw new Error("DuckDB did not write the database file.");
    const file = await wait(handle.getFile());
    const bytes = new Uint8Array(await wait(file.arrayBuffer()));
    if (
      bytes.length < 12288 ||
      new TextDecoder().decode(bytes.subarray(8, 12)) !== "DUCK"
    ) {
      throw new Error("DuckDB did not produce a complete database file.");
    }
    return new File([bytes], `tpch-sf${scaleFactor}.duckdb`, {
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
    // The returned File owns its bytes, so the OPFS copy and this instance's
    // scratch directory can go. Cleanup failures never mask the result.
    if (root) {
      const before = scratchBefore;
      await removeMatching(
        root,
        (name, path) =>
          name === fileName ||
          name === `${fileName}.wal` ||
          (path.split("/").at(-2) === "scratch" && !before.has(path)),
      ).catch(() => 0);
    }
  }
}
