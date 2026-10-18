import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import {
  generateTpchDatabase,
  tpchGenerationError,
  TPCH_WASM_VERSION,
} from "../src/lib/tpch-generator";
import type { TpchScaleFactor } from "../src/lib/tpch-generator";

let calls: string[];
let query: (sql: string) => Promise<void>;
let instantiate: () => Promise<void>;
let worker: TestWorker | undefined;
let workerSource: Blob | undefined;
let bundleURLs: string[];
let openConfig: unknown;
let bytes: Uint8Array;

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
    eh: { mainModule: string; mainWorker: string };
  }) => {
    bundleURLs = Object.values(bundles.eh);
    return bundles.eh;
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
        query: (sql: string) => {
          calls.push(sql);
          return query(sql);
        },
        close: async () => {
          calls.push("close");
        },
      };
    }
    async copyFileToBuffer(name: string) {
      calls.push(`export ${name}`);
      return bytes;
    }
    detach() {
      calls.push("detach worker");
    }
  },
}));

const originalWorker = Object.getOwnPropertyDescriptor(globalThis, "Worker");
const originalCreate = URL.createObjectURL;
const originalRevoke = URL.revokeObjectURL;
let revoked: string[];

beforeEach(() => {
  calls = [];
  bundleURLs = [];
  revoked = [];
  worker = undefined;
  workerSource = undefined;
  openConfig = undefined;
  query = async () => {};
  instantiate = async () => {};
  bytes = new Uint8Array(12288);
  bytes.set(new TextEncoder().encode("DUCK"), 8);
  Object.defineProperty(globalThis, "Worker", {
    configurable: true,
    value: TestWorker,
  });
  URL.createObjectURL = (blob) => {
    workerSource = blob as Blob;
    return "blob:tpch-worker";
  };
  URL.revokeObjectURL = (url) => {
    revoked.push(url);
  };
});

afterEach(() => {
  if (originalWorker)
    Object.defineProperty(globalThis, "Worker", originalWorker);
  else Reflect.deleteProperty(globalThis, "Worker");
  URL.createObjectURL = originalCreate;
  URL.revokeObjectURL = originalRevoke;
});

describe("TPC-H generator", () => {
  test("rejects unsupported factors before creating a worker", async () => {
    for (const value of [0, 1, -0.1, NaN, "0.01); DROP TABLE x;--"]) {
      await expect(
        generateTpchDatabase({ scaleFactor: value as TpchScaleFactor }),
      ).rejects.toThrow("0.01 or 0.1");
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
    const file = await generateTpchDatabase({
      onProgress: (message) => progress.push(message),
    });
    expect(file.name).toBe("tpch-sf0.01.duckdb");
    expect(file.size).toBe(12288);
    expect(openConfig).toEqual({
      path: ":memory:",
      useDirectIO: true,
      maximumThreads: 1,
    });
    expect(calls).toEqual([
      "SET memory_limit = '512MB'",
      "SET custom_extension_repository = 'https://extensions.duckdb.org'",
      "INSTALL tpch",
      "LOAD tpch",
      "ATTACH 'tpch.duckdb' AS generated (STORAGE_VERSION 'v1.5.0')",
      "CALL dbgen(sf = 0.01, catalog = 'generated')",
      "CHECKPOINT generated",
      "DETACH generated",
      "close",
      "export tpch.duckdb",
      "detach worker",
    ]);
    expect(progress).toHaveLength(5);
    expect(
      bundleURLs.every((url) =>
        url.startsWith(
          `https://cdn.jsdelivr.net/npm/@duckdb/duckdb-wasm@${TPCH_WASM_VERSION}/`,
        ),
      ),
    ).toBe(true);
    expect(await workerSource!.text()).toBe(
      `importScripts(${JSON.stringify(bundleURLs[1])});`,
    );
    expect(worker?.terminated).toBe(true);
    expect(revoked).toEqual(["blob:tpch-worker"]);
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
    expect(revoked).toEqual(["blob:tpch-worker"]);
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
    expect(revoked).toEqual(["blob:tpch-worker"]);
    expect(calls).not.toContain("CHECKPOINT generated");
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
    expect(revoked).toEqual(["blob:tpch-worker"]);
  });

  test("does not offer malformed exports", async () => {
    bytes = new Uint8Array(128);
    await expect(generateTpchDatabase()).rejects.toThrow(
      "complete database file",
    );
    expect(worker?.terminated).toBe(true);
  });

  test("error guidance includes network, CSP and memory recovery", () => {
    const message = tpchGenerationError(new Error("network failure"));
    expect(message).toContain("cdn.jsdelivr.net");
    expect(message).toContain("extensions.duckdb.org");
    expect(message).toContain("Blob workers");
    expect(message).toContain("SF 0.01");
    expect(message).toContain("network failure");
  });
});
