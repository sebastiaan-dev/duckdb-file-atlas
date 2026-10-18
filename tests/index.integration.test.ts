import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BinaryReader } from "../src/lib/binary-reader";
import { decodeCatalog } from "../src/lib/checkpoint-catalog";
import { inspectIndexes, attachIndexRanges } from "../src/lib/checkpoint-index";
import { inspectFile } from "../src/lib/reader";
import type { FileInspection } from "../src/lib/types";

const duckdb = process.env.DUCKDB_BIN;
const native = duckdb ? describe : describe.skip;
// These fixtures have aligned payloads; the native checksum's remainder path is not needed.
function checksum(bytes: Uint8Array) {
  if (bytes.length % 8) throw new Error("unaligned test checksum input");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let result = 5381n;
  for (let i = 0; i < bytes.length; i += 8)
    result ^=
      (view.getBigUint64(i, true) * 0xbf58476d1ce4e5b9n) & 0xffffffffffffffffn;
  return result;
}
async function catalogInputs(file: File, physical: FileInspection) {
  const active = physical.headers.find(
    (h) => h.slot === physical.activeHeader,
  )!;
  let raw = BigInt(active.metaBlock);
  const chunks: Uint8Array[] = [],
    seen = new Set<bigint>();
  const slotSize = Math.floor((physical.blockSize - 8) / 64 / 8) * 8;
  while (raw !== 0xffffffffffffffffn) {
    if (seen.has(raw)) throw new Error("catalog cycle");
    seen.add(raw);
    const blockId = Number(raw & 0x00ffffffffffffffn),
      slot = Number(raw >> 56n);
    const block = physical.blocks.find((b) => b.id === blockId)!;
    const bytes = new Uint8Array(
      await file.slice(block.offset, block.offset + block.size).arrayBuffer(),
    );
    const view = new DataView(bytes.buffer);
    expect(view.getBigUint64(0, true)).toBe(checksum(bytes.subarray(8)));
    const start = 8 + slot * slotSize;
    chunks.push(bytes.subarray(start + 8, start + slotSize));
    raw = view.getBigUint64(start, true);
  }
  return decodeCatalog(new BinaryReader(chunks)).flatMap((table) =>
    table.indexes.map((index) => ({ table: table.name, index })),
  );
}
async function sql(sql: string, path?: string) {
  const child = Bun.spawn(
    [duckdb!, ...(path ? [path] : []), "-no-agent", "-batch", "-c", sql],
    { stdout: "pipe", stderr: "pipe" },
  );
  const stderr = await new Response(child.stderr).text();
  await new Response(child.stdout).text();
  expect(await child.exited, stderr).toBe(0);
}
async function fingerprint(file: File) {
  const hasher = new Bun.CryptoHasher("sha256");
  for (let offset = 0; offset < file.size; offset += 8 * 1024 * 1024) {
    hasher.update(
      await file.slice(offset, offset + 8 * 1024 * 1024).arrayBuffer(),
    );
  }
  return hasher.digest("hex");
}
async function inspect(path: string) {
  const file = Bun.file(path) as unknown as File;
  const before = await fingerprint(file);
  const physical = await inspectFile(file);
  expect(physical.native, physical.warnings.join("\n")).toBeDefined();
  const inputs = await catalogInputs(file, physical);
  const indexes = await inspectIndexes(file, physical, inputs, checksum);
  attachIndexRanges(physical.blocks, indexes);
  expect(await fingerprint(file)).toEqual(before);
  return { physical, inputs, indexes };
}

native("native named index occupancy", () => {
  if (process.env.DUCKDB_INDEX_FIXTURE)
    test("read-only existing index fixture", async () => {
      const { physical, indexes } = await inspect(
        process.env.DUCKDB_INDEX_FIXTURE!,
      );
      expect(indexes.length).toBeGreaterThan(0);
      expect(
        indexes.every((index) => index.complete),
        indexes.map((index) => index.reason).join("\n"),
      ).toBe(true);
      for (const block of physical.blocks.filter(
        (block) => block.role === "index",
      )) {
        expect(block.usedBytes).not.toBeNull();
        expect(block.ranges.reduce((sum, range) => sum + range.size, 0)).toBe(
          block.size,
        );
      }
    }, 120000);
  for (const blockSize of [16384, 262144])
    test(`real ${blockSize}-byte blocks: multiple indexes, duplicate leaves, prefixes, churn, empty/singleton`, async () => {
      const directory = await mkdtemp(join(tmpdir(), "atlas-index-")),
        path = join(directory, "indexes.duckdb");
      try {
        await sql(`ATTACH '${path}' AS db (STORAGE_VERSION 'v2.0.0', BLOCK_SIZE ${blockSize});
        CREATE TABLE db.t AS SELECT i, i % 13 AS duplicate, repeat('long-prefix-', 60) || (i % 2000)::VARCHAR AS prefix FROM range(15000) t(i);
        CREATE INDEX named_id ON db.t(i); CREATE INDEX named_duplicate ON db.t(duplicate); CREATE INDEX named_prefix ON db.t(prefix);
        CREATE TABLE db.empty(i BIGINT); CREATE INDEX empty_idx ON db.empty(i);
        CREATE TABLE db.single(i BIGINT); INSERT INTO db.single VALUES (42); CREATE INDEX single_idx ON db.single(i);
        CHECKPOINT db; DELETE FROM db.t WHERE i % 3 = 0; INSERT INTO db.t SELECT i, i % 13, repeat('long-prefix-', 60) || i::VARCHAR FROM range(20000, 23000) t(i); CHECKPOINT db;`);
        const { physical, indexes, inputs } = await inspect(path);
        expect(indexes.map((i) => i.name).sort()).toEqual([
          "empty_idx",
          "named_duplicate",
          "named_id",
          "named_prefix",
          "single_idx",
        ]);
        expect(
          indexes.every((i) => i.complete),
          JSON.stringify(
            inputs.map((i) => ({
              name: i.index.name,
              sizes: i.index.allocatorInfos.map((a) => a.segmentSize),
              options: i.index.options,
            })),
          ),
        ).toBe(true);
        expect(
          indexes.find((i) => i.name === "empty_idx")?.rootPointer.nodeType,
        ).toBe("EMPTY");
        expect(
          indexes.find((i) => i.name === "single_idx")?.rootPointer.nodeType,
        ).not.toBe("EMPTY");
        expect(
          inputs.every((i) => i.index.options.storage_version === "69"),
        ).toBe(true);
        for (const index of indexes) {
          expect(index.allocationBytes).toBe(
            index.occupiedBytes! + index.freeBytes! + index.maskOverheadBytes!,
          );
          for (const allocator of index.allocators)
            for (const buffer of allocator.buffers) {
              expect(
                buffer.runs
                  .filter((r) => r.occupied)
                  .reduce((n, r) => n + r.count, 0),
              ).toBe(buffer.segmentCount);
              expect(buffer.runs.reduce((n, r) => n + r.count, 0)).toBe(
                buffer.storedSlots,
              );
            }
        }
        const blocks = physical.blocks.filter((b) => b.role === "index");
        expect(blocks.length).toBeGreaterThan(0);
        for (const block of blocks) {
          expect(block.usedBytes).not.toBeNull();
          expect(block.indexIds?.length).toBeGreaterThan(0);
          expect(block.ranges.reduce((n, r) => n + r.size, 0)).toBe(block.size);
          expect(
            block.ranges.every(
              (r, i) =>
                !i ||
                r.offset ===
                  block.ranges[i - 1].offset + block.ranges[i - 1].size,
            ),
          ).toBe(true);
        }
        // Mutate real metadata only: physical checksum and masks remain genuine.
        const bad = structuredClone(inputs);
        const allocator = bad
          .find((i) => i.index.allocatorInfos.some((a) => a.bufferIds.length))!
          .index.allocatorInfos.find((a) => a.bufferIds.length)!;
        allocator.segmentCounts[0]++;
        await expect(
          inspectIndexes(
            Bun.file(path) as unknown as File,
            physical,
            bad,
            checksum,
          ),
        ).rejects.toThrow("Corrupt");
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    }, 60000);

  test("retained v1.2 index through v2 upgrade is locally incomplete", async () => {
    const directory = await mkdtemp(join(tmpdir(), "atlas-index-upgrade-")),
      path = join(directory, "old.duckdb");
    try {
      await sql(
        `ATTACH '${path}' AS db (STORAGE_VERSION 'v1.2.0', BLOCK_SIZE 16384); CREATE TABLE db.t AS SELECT i FROM range(10000) t(i); CREATE INDEX retained_idx ON db.t(i); CHECKPOINT db;`,
      );
      await sql(
        `ATTACH '${path}' AS db (STORAGE_VERSION 'v2.0.0'); CREATE TABLE db.other AS SELECT i FROM range(20) t(i); CHECKPOINT db;`,
      );
      const { indexes, physical } = await inspect(path);
      expect(indexes).toHaveLength(1);
      expect(indexes[0].name).toBe("retained_idx");
      expect(indexes[0].complete).toBe(false);
      expect(indexes[0].occupiedBytes).toBeNull();
      expect(indexes[0].reason).toBeDefined();
      expect(physical.native?.complete).toBe(true);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }, 60000);
});
