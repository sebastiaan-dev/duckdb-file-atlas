import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import {
  generateTpchDatabase,
  tpchGenerationError,
} from "../src/lib/tpch-generator";
import {
  buildDatabase,
  duckdbRuntimeURL,
  StatementError,
} from "../src/lib/database-builder";
import runtime from "../vendor/duckdb-wasm/runtime.json";
import type { TpchScaleFactor } from "../src/lib/tpch-generator";

let calls: string[];
let query: (sql: string) => Promise<void>;
let instantiate: () => Promise<void>;
let worker: TestWorker | undefined;
let bundleURLs: string[];
let openConfig: unknown;
let bytes: Uint8Array;

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
  selectBundle: async (bundles: {
    base: { mainModule: string; mainWorker: string };
  }) => {
    bundleURLs = Object.values(bundles.base);
    return bundles.base;
  },
  AsyncDuckDB: class {
    instantiate() {
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

const originalWorker = Object.getOwnPropertyDescriptor(globalThis, "Worker");
const originalStorage = Object.getOwnPropertyDescriptor(
  globalThis.navigator,
  "storage",
);

beforeEach(() => {
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
  if (originalWorker)
    Object.defineProperty(globalThis, "Worker", originalWorker);
  else Reflect.deleteProperty(globalThis, "Worker");
  if (originalStorage)
    Object.defineProperty(globalThis.navigator, "storage", originalStorage);
  else Reflect.deleteProperty(globalThis.navigator, "storage");
});

describe("TPC-H generator", () => {
  test("rejects unsupported factors before creating a worker", async () => {
    for (const value of [0, 10, -0.1, NaN, "0.01); DROP TABLE x;--"]) {
      await expect(
        generateTpchDatabase({ scaleFactor: value as TpchScaleFactor }),
      ).rejects.toThrow("0.01, 0.1 or 1");
    }
    expect(worker).toBeUndefined();
  });

  test("already-aborted requests never start a worker", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      generateTpchDatabase({ signal: controller.signal }),
    ).rejects.toThrow();
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
    const file = await generateTpchDatabase({
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
      "SET memory_limit = '512MB'",
      `SET custom_extension_repository = '${duckdbRuntimeURL("extensions")}'`,
      "INSTALL tpch",
      "LOAD tpch",
      expect.stringMatching(
        /^ATTACH 'opfs:\/\/atlas-build-[0-9a-f-]{36}\.duckdb' AS generated \(STORAGE_VERSION 'v2\.0\.0'\)$/,
      ),
      "USE generated",
      "CALL dbgen(sf = 1, catalog = 'generated')",
      "CHECKPOINT generated",
      "USE memory",
      "DETACH generated",
      "close",
      "detach worker",
    ]);
    // The OPFS copy, its WAL and this run's scratch directory are removed.
    expect(opfsFiles()).toEqual(["duckdb/fs/someone-else.duckdb"]);
    expect(progress).toHaveLength(5);
    // Runtime, worker and extension all come from this site's vendored copy.
    expect(bundleURLs).toEqual([
      duckdbRuntimeURL("duckdb-base.wasm"),
      duckdbRuntimeURL("duckdb-browser-base.worker.js"),
    ]);
    expect(bundleURLs[0]).toContain(`/duckdb-runtime/${runtime.sourceId}/`);
    expect(String(worker?.url)).toBe(bundleURLs[1]);
    expect(worker?.terminated).toBe(true);
  });

  test("supports the bounded larger factor", async () => {
    expect((await generateTpchDatabase({ scaleFactor: 0.1 })).name).toBe(
      "tpch-sf0.1.duckdb",
    );
    expect(calls).toContain("CALL dbgen(sf = 0.1, catalog = 'generated')");
  });

  test("cleans up on extension failures", async () => {
    query = async (sql) => {
      if (sql === "INSTALL tpch") throw new Error("offline");
    };
    await expect(generateTpchDatabase()).rejects.toThrow("offline");
    expect(worker?.terminated).toBe(true);
    expect(calls.some((sql) => sql.startsWith("CALL dbgen"))).toBe(false);
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
      generateTpchDatabase({ signal: controller.signal }),
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
    await expect(generateTpchDatabase()).rejects.toThrow(
      "worker failed to start",
    );
    expect(worker?.terminated).toBe(true);
  });

  test("does not offer malformed exports", async () => {
    bytes = new Uint8Array(128);
    await expect(generateTpchDatabase()).rejects.toThrow(
      "complete database file",
    );
    expect(worker?.terminated).toBe(true);
  });

  test("error guidance includes connection and memory recovery", () => {
    const message = tpchGenerationError(new Error("network failure"));
    expect(message).toContain("DuckDB runtime");
    expect(message).toContain("SF 0.01");
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

  test("options that become SQL must be known values", async () => {
    for (const options of [
      { storageVersion: "v9.9.9' ) ; DROP" },
      { blockSize: 1234 },
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
