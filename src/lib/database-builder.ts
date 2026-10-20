import type { AsyncDuckDB } from "@duckdb/duckdb-wasm";
import runtime from "../../vendor/duckdb-wasm/runtime.json";
import { findFile, opfsRoot, removeMatching, scratchDirectories } from "./opfs";
import { threadSupport } from "./thread-support";

/** The vendored DuckDB 2.0 build; see vendor/duckdb-wasm/README.md. */
export const DUCKDB_WASM_VERSION = runtime.package;
export const DUCKDB_VERSION = runtime.duckdb;

/** Storage formats the builder can write, newest first. */
export const BUILD_STORAGE_VERSIONS = [
  "v2.0.0",
  "v1.5.0",
  "v1.4.0",
  "v1.3.0",
  "v1.2.0",
  "v1.0.0",
] as const;
export type BuildStorageVersion = (typeof BUILD_STORAGE_VERSIONS)[number];
export const DEFAULT_STORAGE_VERSION: BuildStorageVersion = "v2.0.0";
/** Block allocation sizes DuckDB accepts for new files. */
export const BUILD_BLOCK_SIZES = [16384, 32768, 65536, 131072, 262144] as const;
export type BuildBlockSize = (typeof BUILD_BLOCK_SIZES)[number];
export const DEFAULT_BLOCK_SIZE: BuildBlockSize = 262144;

export const BUILD_THREADS = [1, 2, 4, 8] as const;
export type BuildThreads = (typeof BUILD_THREADS)[number];
export const DEFAULT_THREADS: BuildThreads = 1;

/** The attached catalog every script writes into (it is the default). */
export const BUILD_CATALOG = "generated";

/** Prefix of the OPFS files a build writes; leftovers are swept. */
const FILE_PREFIX = "atlas-build-";
// `atlas-tpch-` is the prefix of earlier versions of the generator.
const isBuildFile = (name: string) =>
  /^atlas-(build|tpch)-.*\.duckdb(\.wal)?$/.test(name);

/**
 * Same-origin runtime directory, installed by scripts/fetch-duckdb-runtime.ts.
 * Resolved against the page so the app also works under a deployment subpath.
 */
export function duckdbRuntimeURL(path = "") {
  return new URL(
    `${import.meta.env?.BASE_URL ?? "/"}duckdb-runtime/${runtime.sourceId}/${path}`,
    globalThis.location?.href ?? "http://localhost/",
  ).href;
}

export interface BuildStatement {
  sql: string;
  /** Progress text while it runs; defaults to "Running statement i of n…". */
  label?: string;
  /** 1-based line in the user's script, for error messages. */
  line?: number;
}

/** A statement of the script failed; the database was not produced. */
export class StatementError extends Error {
  constructor(
    readonly index: number,
    readonly count: number,
    readonly statement: BuildStatement,
    readonly detail: string,
  ) {
    super(
      `Statement ${index + 1} of ${count}${statement.line ? ` (line ${statement.line})` : ""} failed: ${detail}`,
    );
    this.name = "StatementError";
  }
}

export interface BuildOptions {
  statements: BuildStatement[];
  /** Name of the returned File. */
  fileName: string;
  storageVersion?: BuildStorageVersion;
  blockSize?: BuildBlockSize;
  threads?: BuildThreads;
  /** Extensions to load up front; others autoload from this site on use. */
  extensions?: string[];
  signal?: AbortSignal;
  /** Stage descriptions, not an estimated percentage of work. */
  onProgress?: (message: string) => void;
  timeoutMs?: number;
  timeoutMessage?: string;
}

/**
 * Run SQL against a fresh database file in an isolated worker and return the
 * checkpointed file. Nothing is uploaded; the runtime and extensions come
 * from this site and are fetched only once a build starts.
 */
export async function buildDatabase({
  statements,
  fileName,
  storageVersion = DEFAULT_STORAGE_VERSION,
  blockSize,
  threads = DEFAULT_THREADS,
  extensions = [],
  signal,
  onProgress,
  timeoutMs = 5 * 60 * 1000,
  timeoutMessage = "The build did not finish within five minutes.",
}: BuildOptions): Promise<File> {
  // Options become SQL text; only accept known values.
  if (!BUILD_STORAGE_VERSIONS.includes(storageVersion))
    throw new Error(`Unsupported storage version ${String(storageVersion)}.`);
  if (blockSize != null && !BUILD_BLOCK_SIZES.includes(blockSize))
    throw new Error(`Unsupported block size ${String(blockSize)}.`);
  if (!BUILD_THREADS.includes(threads))
    throw new Error(`Unsupported thread count ${String(threads)}.`);
  if (extensions.some((name) => !/^[a-z_]+$/.test(name)))
    throw new Error("Invalid extension name.");
  signal?.throwIfAborted();

  let worker: Worker | undefined;
  let db: AsyncDuckDB | undefined;
  // The database is written to OPFS and read back once the worker is gone:
  // this DuckDB 2.0 build keeps detached files locked, so the in-memory
  // filesystem cannot export them, and OPFS also keeps them off the heap.
  const opfsName = `${FILE_PREFIX}${crypto.randomUUID()}.duckdb`;
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
    stop(new DOMException("Generation cancelled.", "AbortError"));
  };
  const workerError = (event: ErrorEvent) =>
    stop(new Error(event.message || "DuckDB worker failed to start."));
  const messageError = () =>
    stop(new Error("Could not receive data from the DuckDB worker."));
  signal?.addEventListener("abort", abort, { once: true });
  const timeout = setTimeout(() => {
    worker?.terminate();
    stop(new Error(timeoutMessage));
  }, timeoutMs);

  try {
    if (threads > 1 && !(await wait(threadSupport())))
      throw new Error(
        "Multiple threads require browser shared-memory support and cross-origin isolation. Choose Single threaded.",
      );
    root = await wait(opfsRoot());
    // Sweep files of earlier runs that were interrupted (e.g. a closed tab).
    await wait(removeMatching(root, isBuildFile));
    scratchBefore = await wait(scratchDirectories(root));
    onProgress?.("Downloading DuckDB runtime…");
    const duckdb = await wait(import("@duckdb/duckdb-wasm"));
    // Keep one-thread builds on the smaller base bundle. Never silently
    // downgrade a requested multithreaded build.
    const bundle = await wait(
      duckdb.selectBundle({
        base: {
          mainModule: duckdbRuntimeURL("duckdb-base.wasm"),
          mainWorker: duckdbRuntimeURL("duckdb-browser-base.worker.js"),
        },
        ...(threads > 1
          ? {
              threads: {
                mainModule: duckdbRuntimeURL("duckdb-threads.wasm"),
                mainWorker: duckdbRuntimeURL(
                  "duckdb-browser-threads.worker.js",
                ),
                pthreadWorker: duckdbRuntimeURL(
                  "duckdb-browser-threads.pthread.worker.js",
                ),
              },
            }
          : {}),
      }),
    );
    if (threads > 1 && !bundle.pthreadWorker)
      throw new Error(
        "The threaded DuckDB runtime is unavailable. Choose Single threaded.",
      );
    worker = new Worker(bundle.mainWorker!);
    worker.addEventListener("error", workerError);
    worker.addEventListener("messageerror", messageError);
    db = new duckdb.AsyncDuckDB(new duckdb.VoidLogger(), worker);
    await wait(db.instantiate(bundle.mainModule, bundle.pthreadWorker));
    await wait(
      db.open({
        path: ":memory:",
        maximumThreads: threads,
        // The vendored CI build ships unsigned extensions, served from this
        // site next to the runtime they were built with.
        allowUnsignedExtensions: true,
        // Let `opfs://` paths open OPFS access handles inside the worker.
        opfs: { fileHandling: "auto" },
      }),
    );
    const connection = await wait(db.connect());
    // Set the SQL scheduler explicitly as well as the WASM configuration.
    // The threaded build may keep additional idle workers in its pool.
    await wait(connection.query(`SET threads = ${threads}`));
    await wait(connection.query("SET memory_limit = '512MB'"));
    await wait(
      connection.query(
        `SET custom_extension_repository = '${duckdbRuntimeURL("extensions")}'`,
      ),
    );
    if (extensions.length)
      onProgress?.(
        `Downloading and loading the ${extensions.map((name) => name.toUpperCase().replace("TPC", "TPC-")).join(", ")} extension…`,
      );
    for (const name of extensions) {
      await wait(connection.query(`INSTALL ${name}`));
      await wait(connection.query(`LOAD ${name}`));
    }
    const options = [
      `STORAGE_VERSION '${storageVersion}'`,
      ...(blockSize ? [`BLOCK_SIZE ${blockSize}`] : []),
    ].join(", ");
    await wait(
      connection.query(
        `ATTACH 'opfs://${opfsName}' AS ${BUILD_CATALOG} (${options})`,
      ),
    );
    // Unqualified names in the script create objects in the new file.
    await wait(connection.query(`USE ${BUILD_CATALOG}`));
    for (const [index, statement] of statements.entries()) {
      onProgress?.(
        statement.label ??
          `Running statement ${index + 1} of ${statements.length}…`,
      );
      try {
        await wait(connection.query(statement.sql));
      } catch (cause) {
        // Cancellation and worker failures are not statement errors.
        if (signal?.aborted || cause instanceof DOMException) throw cause;
        throw new StatementError(
          index,
          statements.length,
          statement,
          cause instanceof Error ? cause.message : String(cause),
        );
      }
    }
    onProgress?.("Checkpointing the database file…");
    await wait(connection.query(`CHECKPOINT ${BUILD_CATALOG}`));
    // The default database cannot be detached.
    await wait(connection.query("USE memory"));
    await wait(connection.query(`DETACH ${BUILD_CATALOG}`));
    await wait(connection.close());
    onProgress?.("Preparing the .duckdb file…");
    // Terminating the worker closes its OPFS access handles.
    db.detach();
    db = undefined;
    worker.terminate();
    const handle = await wait(findFile(root, opfsName));
    if (!handle) throw new Error("DuckDB did not write the database file.");
    const file = await wait(handle.getFile());
    const bytes = new Uint8Array(await wait(file.arrayBuffer()));
    if (
      bytes.length < 12288 ||
      new TextDecoder().decode(bytes.subarray(8, 12)) !== "DUCK"
    ) {
      throw new Error("DuckDB did not produce a complete database file.");
    }
    return new File([bytes], fileName, { type: "application/octet-stream" });
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", abort);
    // No cleanup SQL: that could hang behind a long statement when cancelling.
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
          name === opfsName ||
          name === `${opfsName}.wal` ||
          (path.split("/").at(-2) === "scratch" && !before.has(path)),
      ).catch(() => 0);
    }
  }
}
