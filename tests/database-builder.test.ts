import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import {
  buildError,
  buildScenario,
  DEFAULT_SCENARIO_STATE,
} from "../src/lib/scenarios";
import {
  buildDatabase,
  duckdbRuntimeURL,
  StatementError,
} from "../src/lib/database-builder";
import runtime from "../vendor/duckdb-wasm/runtime.json";

let calls: string[];
let query: (sql: string) => Promise<void>;
let instantiate: () => Promise<void>;
let worker: TestWorker | undefined;
let bundleURLs: string[];
let openConfig: unknown;
let bytes: Uint8Array;
let instantiated: unknown[];
let supportsThreads = true;

/** Minimal in-memory OPFS: directories of named files and subdirectories. */
class FakeDirectory {
  readonly kind = "directory";
  children = new Map<string, FakeDirectory | FakeFile>();
  async *entries() {
    yield* [...this.children.entries()];
  }
  async getDirectoryHandle(name: string) {
    let child = this.children.get(name);
    if (!child) this.children.set(name, (child = new FakeDirectory()));
    return child as FakeDirectory;
  }
  async removeEntry(name: string) {
    this.children.delete(name);
  }
}
class FakeFile {
  readonly kind = "file";
  constructor(public bytes: Uint8Array) {}
  async getFile() {
    return new File([this.bytes], "file");
  }
}
let opfs: FakeDirectory;
/** Every file path in the fake OPFS, for leak checks. */
function opfsFiles(directory = opfs, path = ""): string[] {
  return [...directory.children].flatMap(([name, child]) =>
    child instanceof FakeDirectory
      ? opfsFiles(child, `${path}${name}/`)
      : [`${path}${name}`],
  );
}

class TestWorker extends EventTarget {
  terminated = false;
  constructor(public url: string | URL) {
    super();
    worker = this;
  }
  terminate() {
    this.terminated = true;
  }
}

mock.module("@duckdb/duckdb-wasm", () => ({
  VoidLogger: class {},
  getPlatformFeatures: async () => ({
    crossOriginIsolated: globalThis.crossOriginIsolated,
    wasmExceptions: true,
    wasmSIMD: true,
    wasmThreads: supportsThreads,
  }),
  selectBundle: async (bundles: {
    base: { mainModule: string; mainWorker: string };
    threads?: { mainModule: string; mainWorker: string; pthreadWorker: string };
  }) => {
    const bundle = bundles.threads ?? bundles.base;
    bundleURLs = Object.values(bundle);
    return bundle;
  },
  AsyncDuckDB: class {
    instantiate(...args: unknown[]) {
      instantiated = args;
      return instantiate();
    }
    async open(config: unknown) {
      openConfig = config;
    }
    async connect() {
      return {
        query: async (sql: string) => {
          calls.push(sql);
          await query(sql);
          // DuckDB-WASM decides where in OPFS an `opfs://` file lives.
          const attached = /^ATTACH 'opfs:\/\/([^']+)'/.exec(sql)?.[1];
          if (attached) {
            const fs = await (
              await opfs.getDirectoryHandle("duckdb")
            ).getDirectoryHandle("fs");
            fs.children.set(attached, new FakeFile(bytes));
            fs.children.set(`${attached}.wal`, new FakeFile(new Uint8Array()));
            const scratch = await (
              await opfs.getDirectoryHandle("duckdb")
            ).getDirectoryHandle("scratch");
            (await scratch.getDirectoryHandle("instance")).children.set(
              "pool-0",
              new FakeFile(new Uint8Array()),
            );
          }
        },
        close: async () => {
          calls.push("close");
        },
      };
    }
    detach() {
      calls.push("detach worker");
    }
  },
}));

const originalIsolation = Object.getOwnPropertyDescriptor(
  globalThis,
  "crossOriginIsolated",
);
const originalWorker = Object.getOwnPropertyDescriptor(globalThis, "Worker");
const originalStorage = Object.getOwnPropertyDescriptor(
  globalThis.navigator,
  "storage",
);

beforeEach(() => {
  instantiated = [];
  supportsThreads = true;
  Object.defineProperty(globalThis, "crossOriginIsolated", {
    configurable: true,
    value: true,
  });
  calls = [];
  bundleURLs = [];
  worker = undefined;
  openConfig = undefined;
  query = async () => {};
  instantiate = async () => {};
  bytes = new Uint8Array(12288);
  bytes.set(new TextEncoder().encode("DUCK"), 8);
  Object.defineProperty(globalThis, "Worker", {
    configurable: true,
    value: TestWorker,
  });
  opfs = new FakeDirectory();
  Object.defineProperty(globalThis.navigator, "storage", {
    configurable: true,
    value: { getDirectory: async () => opfs },
  });
});

afterEach(() => {
  if (originalIsolation)
    Object.defineProperty(globalThis, "crossOriginIsolated", originalIsolation);
  else Reflect.deleteProperty(globalThis, "crossOriginIsolated");
  if (originalWorker)
    Object.defineProperty(globalThis, "Worker", originalWorker);
  else Reflect.deleteProperty(globalThis, "Worker");
  if (originalStorage)
    Object.defineProperty(globalThis.navigator, "storage", originalStorage);
  else Reflect.deleteProperty(globalThis.navigator, "storage");
});

/** Build the TPC-H scenario at a scale factor. */
const tpch = (
  sf: string,
  options: { signal?: AbortSignal; onProgress?: (m: string) => void } = {},
) =>
  buildScenario(
    {
      ...DEFAULT_SCENARIO_STATE,
      id: "tpch",
      settings: { ...DEFAULT_SCENARIO_STATE.settings, tpch: { sf } },
    },
    options,
  );

describe("TPC-H scenario", () => {
  test("unknown settings fall back to defaults and never reach SQL", async () => {
    await tpch("0.01); DROP TABLE x;--");
    expect(calls).toContain("CALL dbgen(sf = 1)");
    expect(calls.some((sql) => sql.includes("DROP"))).toBe(false);
  });

  test("already-aborted requests never start a worker", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(tpch("1", { signal: controller.signal })).rejects.toThrow();
    expect(worker).toBeUndefined();
  });

  test("checkpoints and detaches the real file before export, then cleans up", async () => {
    const progress: string[] = [];
    // An interrupted earlier run left files behind; unrelated files stay.
    const stale = await (
      await opfs.getDirectoryHandle("duckdb")
    ).getDirectoryHandle("fs");
    stale.children.set("atlas-tpch-old.duckdb", new FakeFile(bytes));
    stale.children.set("someone-else.duckdb", new FakeFile(bytes));
    const file = await tpch("1", {
      onProgress: (message) => progress.push(message),
    });
    expect(file.name).toBe("tpch-sf1.duckdb");
    expect(file.size).toBe(12288);
    expect(openConfig).toEqual({
      path: ":memory:",
      maximumThreads: 1,
      allowUnsignedExtensions: true,
      opfs: { fileHandling: "auto" },
    });
    expect(calls).toEqual([
      "SET threads = 1",
      "SET memory_limit = '512MB'",
      `SET custom_extension_repository = '${duckdbRuntimeURL("extensions")}'`,
      expect.stringMatching(
        /^ATTACH 'opfs:\/\/atlas-build-[0-9a-f-]{36}\.duckdb' AS generated \(STORAGE_VERSION 'v2\.0\.0', BLOCK_SIZE 262144\)$/,
      ),
      "USE generated",
      // dbgen autoloads the TPC-H extension from this site.
      "CALL dbgen(sf = 1)",
      "CHECKPOINT generated",
      "USE memory",
      "DETACH generated",
      "close",
      "detach worker",
    ]);
    // The OPFS copy, its WAL and this run's scratch directory are removed.
    expect(opfsFiles()).toEqual(["duckdb/fs/someone-else.duckdb"]);
    expect(progress).toEqual([
      "Downloading DuckDB runtime…",
      "Running statement 1 of 1…",
      "Checkpointing the database file…",
      "Preparing the .duckdb file…",
    ]);
    // Runtime, worker and extensions all come from this site's vendored copy.
    expect(bundleURLs).toEqual([
      duckdbRuntimeURL("duckdb-base.wasm"),
      duckdbRuntimeURL("duckdb-browser-base.worker.js"),
    ]);
    expect(bundleURLs[0]).toContain(`/duckdb-runtime/${runtime.sourceId}/`);
    expect(String(worker?.url)).toBe(bundleURLs[1]);
    expect(worker?.terminated).toBe(true);
  });

  test("supports smaller factors", async () => {
    expect((await tpch("0.1")).name).toBe("tpch-sf0.1.duckdb");
    expect(calls).toContain("CALL dbgen(sf = 0.1)");
  });

  test("cleans up when the extension cannot load", async () => {
    query = async (sql) => {
      if (sql.startsWith("CALL dbgen"))
        throw new Error("IO Error: Extension tpch could not be installed");
    };
    await expect(tpch("1")).rejects.toBeInstanceOf(StatementError);
    expect(worker?.terminated).toBe(true);
    expect(calls).not.toContain("CHECKPOINT generated");
    expect(opfsFiles()).toEqual([]);
  });

  test("cancellation rejects even when a worker query never returns", async () => {
    const controller = new AbortController();
    query = (sql) => {
      if (sql.startsWith("CALL dbgen")) {
        controller.abort();
        return new Promise(() => {});
      }
      return Promise.resolve();
    };
    await expect(
      tpch("1", { signal: controller.signal }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(worker?.terminated).toBe(true);
    expect(calls).not.toContain("CHECKPOINT generated");
    // Cancelling mid-generation still removes the partial OPFS file.
    expect(opfsFiles()).toEqual([]);
  });

  test("worker startup errors do not leave instantiate pending", async () => {
    instantiate = () => {
      queueMicrotask(() => worker!.dispatchEvent(new Event("error")));
      return new Promise(() => {});
    };
    await expect(tpch("1")).rejects.toThrow("worker failed to start");
    expect(worker?.terminated).toBe(true);
  });

  test("does not offer malformed exports", async () => {
    bytes = new Uint8Array(128);
    await expect(tpch("1")).rejects.toThrow("complete database file");
    expect(worker?.terminated).toBe(true);
  });

  test("error guidance includes connection and memory recovery", () => {
    const message = buildError(new Error("network failure"));
    expect(message).toContain("DuckDB runtime");
    expect(message).toContain("smaller scenario");
    expect(message).toContain("network failure");
  });
});

describe("database builder", () => {
  const script = [
    { sql: "CREATE TABLE t AS SELECT 1 AS a", line: 1 },
    { sql: "INSERT INTO t VALUES (2)", line: 2 },
  ];

  test("runs each statement in the new file with the chosen format", async () => {
    const progress: string[] = [];
    const file = await buildDatabase({
      statements: script,
      fileName: "custom.duckdb",
      storageVersion: "v1.2.0",
      blockSize: 16384,
      onProgress: (message) => progress.push(message),
    });
    expect(file.name).toBe("custom.duckdb");
    expect(calls).toEqual([
      "SET threads = 1",
      "SET memory_limit = '512MB'",
      `SET custom_extension_repository = '${duckdbRuntimeURL("extensions")}'`,
      expect.stringMatching(
        /AS generated \(STORAGE_VERSION 'v1\.2\.0', BLOCK_SIZE 16384\)$/,
      ),
      "USE generated",
      "CREATE TABLE t AS SELECT 1 AS a",
      "INSERT INTO t VALUES (2)",
      "CHECKPOINT generated",
      "USE memory",
      "DETACH generated",
      "close",
      "detach worker",
    ]);
    expect(progress).toContain("Running statement 2 of 2…");
    expect(opfsFiles()).toEqual([]);
  });

  test("a failing statement reports its number and line, and cleans up", async () => {
    query = async (sql) => {
      if (sql.startsWith("INSERT"))
        throw new Error("Catalog Error: Table with name u does not exist!");
    };
    const error = await buildDatabase({
      statements: script,
      fileName: "custom.duckdb",
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(StatementError);
    expect((error as StatementError).message).toBe(
      "Statement 2 of 2 (line 2) failed: Catalog Error: Table with name u does not exist!",
    );
    expect((error as StatementError).statement.line).toBe(2);
    expect(calls).not.toContain("CHECKPOINT generated");
    expect(worker?.terminated).toBe(true);
    expect(opfsFiles()).toEqual([]);
  });

  for (const threads of [2, 4, 8] as const) {
    test(`selects the threaded runtime and scheduler for ${threads} threads`, async () => {
      await buildDatabase({
        statements: script,
        fileName: "threads.duckdb",
        threads,
      });
      expect(openConfig).toMatchObject({ maximumThreads: threads });
      expect(calls[0]).toBe(`SET threads = ${threads}`);
      expect(instantiated).toEqual([
        duckdbRuntimeURL("duckdb-threads.wasm"),
        duckdbRuntimeURL("duckdb-browser-threads.pthread.worker.js"),
      ]);
      expect(worker?.url).toBe(
        duckdbRuntimeURL("duckdb-browser-threads.worker.js"),
      );
      expect(opfsFiles()).toEqual([]);
    });
  }

  test("does not silently downgrade when isolation is missing", async () => {
    Object.defineProperty(globalThis, "crossOriginIsolated", {
      configurable: true,
      value: false,
    });
    await expect(
      buildDatabase({ statements: script, fileName: "x.duckdb", threads: 2 }),
    ).rejects.toThrow("Choose Single threaded");
    expect(worker).toBeUndefined();
    // The base bundle still works on these browsers.
    await buildDatabase({
      statements: script,
      fileName: "x.duckdb",
      threads: 1,
    });
    expect(worker?.url).toBe(duckdbRuntimeURL("duckdb-browser-base.worker.js"));
  });

  test("rejects threads when shared WASM memory is unsupported", async () => {
    supportsThreads = false;
    await expect(
      buildDatabase({ statements: script, fileName: "x.duckdb", threads: 8 }),
    ).rejects.toThrow("Choose Single threaded");
    expect(worker).toBeUndefined();
  });

  test("options that become SQL must be known values", async () => {
    for (const options of [
      { storageVersion: "v9.9.9' ) ; DROP" },
      { blockSize: 1234 },
      { threads: 3 },
      { threads: "2; DROP" },
      { extensions: ["tpch; DROP"] },
    ])
      await expect(
        buildDatabase({
          statements: script,
          fileName: "x.duckdb",
          ...(options as object),
        }),
      ).rejects.toThrow(/Unsupported|Invalid/);
    expect(worker).toBeUndefined();
  });
});
