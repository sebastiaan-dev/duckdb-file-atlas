import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BinaryReader,
  readMetaPointer,
  safeInteger,
  type MetaPointer,
} from "../src/lib/binary-reader";
import { decodeCatalog } from "../src/lib/checkpoint-catalog";
import { readTableStatistics } from "../src/lib/checkpoint-column";
import {
  decodeCheckpointDeletes,
  type CheckpointDeletes,
} from "../src/lib/checkpoint-delete";
import { inspectFile } from "../src/lib/reader";

const duckdb = process.env.DUCKDB_BIN;
const native = duckdb ? describe : describe.skip;
const literal = (path: string) => "'" + path.replaceAll("'", "''") + "'";

async function sql(path: string | null, statement: string): Promise<string> {
  const child = Bun.spawn(
    [
      duckdb!,
      ...(path ? [path] : []),
      "-no-agent",
      "-no-init",
      "-batch",
      "-bail",
      // Keep deletion masks persisted rather than compacting row groups away.
      "-csv",
      "-noheader",
      "-c",
      `SET max_vacuum_tasks=0; ${statement}`,
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  const [stdout, stderr] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  expect(await child.exited, stderr).toBe(0);
  return stdout.trim();
}

/**
 * Independent native-stream harness cross-checks integrated rowGroupsInfo.
 * inspectFile verifies block checksums; this harness only opens metadata slots
 * and reads catalog/row descriptors to reach the real delete root. It never
 * treats the allocation pointer list as multiple delete payloads.
 */
async function nativeDeletes(path: string) {
  const file = Bun.file(path) as unknown as File;
  const inspection = await inspectFile(file);
  expect(inspection.native?.complete, inspection.warnings.join("\n")).toBe(
    true,
  );
  const all = new Uint8Array(await file.arrayBuffer());
  const slotSize = Math.floor((inspection.blockSize - 8) / 64 / 8) * 8;
  const open = (pointer: MetaPointer): BinaryReader => {
    const chunks: Uint8Array[] = [];
    const seen = new Set<bigint>();
    let raw = pointer.blockPointer,
      offset = Math.max(8, pointer.offset);
    while (raw !== 0xffffffffffffffffn) {
      expect(seen.has(raw)).toBe(false);
      expect(seen.size).toBeLessThan(4096);
      seen.add(raw);
      const id = Number(raw & ((1n << 56n) - 1n));
      const slot = Number(raw >> 56n);
      const block = inspection.blocks[id + 3];
      expect(block).toBeDefined();
      expect(slot).toBeLessThan(64);
      const base = block.offset + 8 + slot * slotSize;
      const free =
        block.role === "free" ||
        block.ranges.some(
          (range) =>
            range.kind === "unused" &&
            range.offset <= base &&
            range.offset + range.size > base,
        );
      if (free) {
        expect(chunks.length).toBeGreaterThan(0);
        break;
      }
      chunks.push(all.subarray(base + offset, base + slotSize));
      raw = new DataView(all.buffer, base, 8).getBigUint64(0, true);
      offset = 8;
    }
    return new BinaryReader(chunks);
  };
  const header = inspection.headers.find(
    (header) => header.slot === inspection.activeHeader,
  )!;
  const tables = decodeCatalog(
    open({ blockPointer: BigInt(header.metaBlock), offset: 0 }),
  );
  const groups: Array<{
    table: string;
    start: number;
    physicalRows: number;
    pointerCount: number;
    consumedBytes: number;
    deletes: CheckpointDeletes;
  }> = [];
  for (const table of tables) {
    const reader = open(table.pointer);
    readTableStatistics(
      reader,
      table.columns.map((column) => column.type),
    );
    const count = safeInteger(reader.fixedU64());
    for (let group = 0; group < count; group++) {
      const row = reader.object(() => {
        reader.field(100);
        const start = reader.uint();
        reader.field(101);
        const physicalRows = reader.uint();
        reader.field(102);
        reader.list(() => readMetaPointer(reader));
        reader.field(103);
        const pointers = reader.list(() => readMetaPointer(reader));
        if (reader.optional(104)) reader.bool();
        if (reader.optional(105)) reader.list(() => reader.unsigned());
        if (reader.optional(106)) reader.bool();
        if (reader.optional(107)) reader.list(() => reader.unsigned());
        return { start, physicalRows, pointers };
      });
      const root = row.pointers.length ? open(row.pointers[0]) : null;
      const deletes = root
        ? decodeCheckpointDeletes(root, inspection.vectorSize, row.physicalRows)
        : { deletedRows: 0, vectors: [] };
      groups.push({
        table: table.name,
        start: row.start,
        physicalRows: row.physicalRows,
        pointerCount: row.pointers.length,
        consumedBytes: root?.offset ?? 0,
        deletes,
      });
    }
  }
  expect(inspection.native?.rowGroupsInfo).toHaveLength(groups.length);
  for (const group of groups) {
    const integrated = inspection.native!.rowGroupsInfo!.find(
      (row) => row.table === group.table && row.rowStart === group.start,
    );
    expect(integrated).toMatchObject({
      physicalRows: group.physicalRows,
      deletedRows: group.deletes.deletedRows,
      liveRows: group.physicalRows - group.deletes.deletedRows,
      deleteVectors: group.deletes.vectors,
    });
  }
  return { inspection, groups };
}

native("native checkpoint row deletes", () => {
  test("matches SQL counts for full, sparse, dense, mixed and final partial vectors", async () => {
    const directory = await mkdtemp(join(tmpdir(), "atlas-delete-"));
    const path = join(directory, "deletes.duckdb");
    try {
      // sqllogictest-style sequence: statement ok / query I => 5838.
      await sql(
        path,
        `CREATE TABLE t AS SELECT i FROM range(10000) t(i); CHECKPOINT;
        DELETE FROM t WHERE i<2048 OR i=2051
          OR (i>=4096 AND i<6144 AND i%32<>0)
          OR (i>=6144 AND i<8192 AND i%16=0) OR i=9999; CHECKPOINT;`,
      );
      expect(await sql(path, "SELECT count(*) FROM t")).toBe("5838");
      const before = await Bun.file(path).arrayBuffer();
      const { groups } = await nativeDeletes(path);
      const rows = groups.filter((g) => g.table === "main.t");
      expect(rows.reduce((sum, g) => sum + g.physicalRows, 0)).toBe(10000);
      expect(rows.reduce((sum, g) => sum + g.deletes.deletedRows, 0)).toBe(
        4162,
      );
      const vectors = rows.flatMap((g) => g.deletes.vectors);
      expect(new Set(vectors.map((v) => v.encoding))).toEqual(
        new Set([
          "constant",
          "deleted-positions",
          "alive-positions",
          "bitmask",
        ]),
      );
      expect(vectors.at(-1)).toMatchObject({
        rowStart: 8192,
        rowCount: 1808,
        deletedRows: 1,
        deletedRanges: [{ start: 9999, count: 1 }],
      });
      expect(await Bun.file(path).arrayBuffer()).toEqual(before);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }, 60000);

  test("crosses many metadata slots in 16 KiB blocks and reuses unchanged delete roots", async () => {
    const directory = await mkdtemp(join(tmpdir(), "atlas-delete-slots-"));
    const path = join(directory, "slots.duckdb");
    try {
      await sql(
        null,
        `ATTACH ${literal(path)} AS db (STORAGE_VERSION 'v2.0.0', BLOCK_SIZE 16384);
        USE db; CREATE TABLE t AS SELECT i FROM range(400000) t(i); CHECKPOINT;
        DELETE FROM t WHERE i%3=0; CHECKPOINT;`,
      );
      const first = await nativeDeletes(path);
      expect(first.inspection.blockSize).toBe(16384);
      expect(first.groups.some((g) => g.pointerCount > 1)).toBe(true);
      expect(first.groups.some((g) => g.consumedBytes > (16384 - 8) / 64)).toBe(
        true,
      );
      expect(
        first.groups.reduce((sum, g) => sum + g.deletes.deletedRows, 0),
      ).toBe(133334);
      expect(await sql(path, "SELECT count(*) FROM t")).toBe("266666");
      for (let checkpoint = 0; checkpoint < 3; checkpoint++) {
        await sql(
          path,
          `CREATE TABLE extra${checkpoint} AS SELECT i FROM range(100) t(i); CHECKPOINT;`,
        );
        const { groups } = await nativeDeletes(path);
        expect(
          groups.filter((g) => g.table === "main.t").map((g) => g.deletes),
        ).toEqual(first.groups.map((g) => g.deletes));
        expect(
          groups
            .filter((g) => g.table !== "main.t")
            .every(
              (g) =>
                g.pointerCount === 0 &&
                g.deletes.deletedRows === 0 &&
                g.deletes.vectors.length === 0,
            ),
        ).toBe(true);
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }, 60000);

  test("decodes retained old delete streams after a 16 KiB revision-69 upgrade", async () => {
    const directory = await mkdtemp(join(tmpdir(), "atlas-delete-upgrade-"));
    const path = join(directory, "upgrade.duckdb");
    try {
      await sql(
        null,
        `ATTACH ${literal(path)} AS old (STORAGE_VERSION 'v1.2.0', BLOCK_SIZE 16384);
        CREATE TABLE old.t AS SELECT i FROM range(10000) t(i); CHECKPOINT old;
        DELETE FROM old.t WHERE i%17=0; CHECKPOINT old; DETACH old;
        ATTACH ${literal(path)} AS upgraded (STORAGE_VERSION 'v2.0.0');
        CREATE TABLE upgraded.fresh AS SELECT i FROM range(100) t(i); CHECKPOINT upgraded;`,
      );
      expect(await sql(path, "SELECT count(*) FROM t")).toBe("9411");
      const { inspection, groups } = await nativeDeletes(path);
      expect(inspection.storageVersion).toBe(69);
      expect(inspection.blockSize).toBe(16384);
      expect(
        groups
          .filter((g) => g.table === "main.t")
          .reduce((sum, g) => sum + g.deletes.deletedRows, 0),
      ).toBe(589);
      expect(
        groups
          .filter((g) => g.table === "main.fresh")
          .every((g) => g.pointerCount === 0 && g.deletes.deletedRows === 0),
      ).toBe(true);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }, 60000);
});
