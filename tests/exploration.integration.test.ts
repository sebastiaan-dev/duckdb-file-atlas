import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspectFile } from "../src/lib/reader";

const binary = process.env.DUCKDB_BIN;
const native = binary ? describe : describe.skip;

native("integrated checkpoint exploration", () => {
  test("valid large deletion masks fall back on inspection limits instead of being rejected as corrupt", async () => {
    const directory = await mkdtemp(join(tmpdir(), "atlas-delete-budget-"));
    const path = join(directory, "large.duckdb");
    try {
      const literal = `'${path.replaceAll("'", "''")}'`;
      const child = Bun.spawn(
        [
          binary!,
          "-no-agent",
          "-batch",
          "-bail",
          "-c",
          `
        SET max_vacuum_tasks=0;
        ATTACH ${literal} AS db (STORAGE_VERSION 'v2.0.0', ROW_GROUP_SIZE 1048576);
        CREATE TABLE db.t AS SELECT i FROM range(600000) t(i);
        CHECKPOINT db;
        DELETE FROM db.t WHERE i%2=0;
        CHECKPOINT db;
      `,
        ],
        { stdout: "pipe", stderr: "pipe" },
      );
      const error = await new Response(child.stderr).text();
      await new Response(child.stdout).text();
      expect(await child.exited, error).toBe(0);
      const inspection = await inspectFile(Bun.file(path) as unknown as File);
      expect(inspection.capabilities.semantic).toBe(false);
      expect(
        inspection.warnings.some((warning) =>
          warning.includes("range work limit exceeded"),
        ),
      ).toBe(true);
      expect(inspection.blocks.length).toBeGreaterThan(3);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }, 60000);

  test("names index allocations, refines metadata and reports persisted deletes without changing bytes", async () => {
    const directory = await mkdtemp(join(tmpdir(), "atlas-exploration-"));
    const path = join(directory, "exploration.duckdb");
    try {
      const child = Bun.spawn(
        [
          binary!,
          path,
          "-no-agent",
          "-batch",
          "-bail",
          "-c",
          `
        SET max_vacuum_tasks=0;
        CREATE TABLE t AS SELECT i, i%7 AS category FROM range(30000) t(i);
        CHECKPOINT;
        DELETE FROM t WHERE i%3=0;
        CHECKPOINT;
        CREATE INDEX by_id ON t(i);
        CREATE INDEX by_category ON t(category);
        CHECKPOINT;
      `,
        ],
        { stdout: "pipe", stderr: "pipe" },
      );
      const error = await new Response(child.stderr).text();
      await new Response(child.stdout).text();
      expect(await child.exited, error).toBe(0);
      const before = await Bun.file(path).arrayBuffer();
      const inspection = await inspectFile(Bun.file(path) as unknown as File);
      expect(inspection.native?.complete, inspection.warnings.join("\n")).toBe(
        true,
      );
      expect(
        inspection.native?.catalog?.find((table) => table.name === "main.t"),
      ).toMatchObject({ rows: 30000, deletedRows: 10000, liveRows: 20000 });
      expect(
        inspection.native?.rowGroupsInfo?.reduce(
          (sum, row) => sum + row.deletedRows,
          0,
        ),
      ).toBe(10000);
      expect(inspection.indexes?.map((index) => index.name).sort()).toEqual([
        "by_category",
        "by_id",
      ]);
      for (const index of inspection.indexes!) {
        expect(index.complete, index.reason).toBe(true);
        expect(index.occupiedBytes).toBeGreaterThan(0);
        expect(index.allocationBytes).toBe(
          index.occupiedBytes! + index.freeBytes! + index.maskOverheadBytes!,
        );
        for (const id of index.blockIds) {
          const block = inspection.blocks.find((block) => block.id === id)!;
          expect(block.role).toBe("index");
          expect(block.indexOwners).toContainEqual({
            id: index.id,
            table: "main.t",
            name: index.name,
          });
          expect(block.checksum).toMatch(/^0x[0-9a-f]{16}$/);
          expect(block.ranges.some((range) => range.indexId === index.id)).toBe(
            true,
          );
        }
      }
      const metadata = inspection.blocks
        .filter((block) => block.role === "metadata")
        .flatMap((block) => block.ranges);
      for (const label of [
        "Checkpoint catalog",
        "main.t: table statistics",
        "main.t: row group 0",
        "main.t.i: column metadata (row group 0)",
        "main.t: deletion masks (row group 0)",
      ]) {
        expect(metadata.some((range) => range.label === label)).toBe(true);
      }
      for (const block of inspection.blocks) {
        let cursor = block.offset;
        for (const range of [...block.ranges].sort(
          (a, b) => a.offset - b.offset,
        )) {
          expect(range.offset).toBe(cursor);
          cursor += range.size;
        }
        expect(cursor).toBe(block.offset + block.size);
      }
      expect(await Bun.file(path).arrayBuffer()).toEqual(before);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }, 60000);
});
