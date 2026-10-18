import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspectFile, inspectPhysicalFile, readBytes } from "../src/lib/reader";
import { applyManifest } from "../src/lib/semantic";
import { collectManifest } from "../scripts/inspect";

const duckdb = process.env.DUCKDB_BIN;
const native = duckdb ? describe : describe.skip;

/** Run against a source-built revision-69 engine rather than a mirrored TS fixture writer. */
native("native DuckDB revision 69 integration", () => {
  test("reads a real checkpoint, enriches quoted catalog names, and preserves the database", async () => {
    const directory = await mkdtemp(join(tmpdir(), "file-atlas-native-"));
    const path = join(directory, "real.duckdb");
    try {
      const sql = `CREATE TABLE discarded AS SELECT hash(i) AS payload FROM range(300000) t(i);
        CREATE SCHEMA "analytics's";
        CREATE TABLE "analytics's"."order's events" AS
        SELECT i AS "event id", 'event-' || (i % 4096)::VARCHAR AS category,
               CASE WHEN i % 7 = 0 THEN NULL ELSE i * 0.25 END AS amount
        FROM range(250000) t(i);
        CHECKPOINT; DROP TABLE discarded; CHECKPOINT;`;
      const create = Bun.spawn([duckdb!, path, "-batch", "-c", sql], {
        stdout: "pipe",
        stderr: "pipe",
      });
      const diagnostic = await new Response(create.stderr).text();
      expect(await create.exited, diagnostic).toBe(0);
      const before = await Bun.file(path).arrayBuffer();
      const inspection = await inspectFile(Bun.file(path) as unknown as File);
      expect(inspection.storageVersion).toBe(69);
      expect(inspection.native, inspection.warnings.join("\n")).toBeDefined();
      expect(
        inspection.segments.some(
          (segment) => segment.blockId >= 0 && segment.byteSize != null,
        ),
      ).toBe(true);
      expect(inspection.headers.filter((header) => header.valid).length).toBe(
        2,
      );
      expect(inspection.blocks.some((block) => block.role === "metadata")).toBe(
        true,
      );
      expect(inspection.blocks.some((block) => block.role === "free")).toBe(
        true,
      );
      expect(inspection.blocks.filter((block) => block.id < 0).length).toBe(3);
      expect(
        inspection.blocks.reduce((sum, block) => sum + block.size, 0),
      ).toBe(before.byteLength);
      expect(inspection.headerFingerprint).toMatch(/^[a-f0-9]{64}$/);
      const sample = await readBytes(Bun.file(path) as unknown as File, 8, 4);
      expect(new TextDecoder().decode(sample)).toBe("DUCK");

      const exporter = Bun.spawn(
        [process.execPath, "scripts/inspect.ts", "--duckdb", duckdb!, path],
        {
          cwd: join(import.meta.dir, ".."),
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      const [stdout, stderr] = await Promise.all([
        new Response(exporter.stdout).text(),
        new Response(exporter.stderr).text(),
      ]);
      expect(await exporter.exited, stderr).toBe(0);
      const manifest = JSON.parse(stdout);
      const enriched = applyManifest(
        await inspectPhysicalFile(Bun.file(path) as unknown as File),
        manifest,
      );
      expect(enriched.capabilities.semantic).toBe(true);
      expect(
        enriched.segments.some((segment) =>
          segment.table.includes("order's events"),
        ),
      ).toBe(true);
      expect(
        enriched.segments.some((segment) =>
          segment.column.includes("event id"),
        ),
      ).toBe(true);
      expect(
        new Set(enriched.segments.map((segment) => segment.rowGroup)).size,
      ).toBeGreaterThan(1);
      expect(
        enriched.segments.every((segment) => segment.byteSize === null),
      ).toBe(true);
      expect(enriched.capabilities.exactSizes).toBe(false);
      expect(await Bun.file(path).arrayBuffer()).toEqual(before);
      for (const suffix of [".wal", ".wal.checkpoint", ".wal.recovery"]) {
        await Bun.write(path + suffix, "uncheckpointed changes");
        await expect(collectManifest(path, duckdb!)).rejects.toThrow(
          /Unresolved WAL/,
        );
        await rm(path + suffix);
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }, 60000);
  test("reads a revision-69 upgrade with a legacy main marker and 16 KiB blocks", async () => {
    const directory = await mkdtemp(join(tmpdir(), "file-atlas-upgrade-"));
    const path = join(directory, "upgraded.duckdb");
    const literal = "'" + path.replaceAll("'", "''") + "'";
    try {
      const sql = `ATTACH ${literal} AS old (STORAGE_VERSION 'v1.2.0', BLOCK_SIZE 16384);
        CREATE TABLE old.t AS SELECT i FROM range(10000) t(i); CHECKPOINT old; DETACH old;
        ATTACH ${literal} AS upgraded (STORAGE_VERSION 'v2.0.0');
        CREATE TABLE upgraded.t2 AS SELECT i FROM range(100) t(i); CHECKPOINT upgraded;`;
      const child = Bun.spawn([duckdb!, "-no-agent", "-batch", "-c", sql], {
        stdout: "pipe",
        stderr: "pipe",
      });
      const stderr = await new Response(child.stderr).text();
      expect(await child.exited, stderr).toBe(0);
      const file = Bun.file(path) as unknown as File;
      const prefix = await readBytes(file, 0, 20);
      expect(new DataView(prefix.buffer).getBigUint64(12, true)).toBe(65n);
      const inspection = await inspectFile(file);
      expect(inspection.storageVersion).toBe(69);
      expect(inspection.blockSize).toBe(16384);
      expect(inspection.blocks.some((block) => block.role === "metadata")).toBe(
        true,
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }, 60000);
});

native("native checkpoint semantics and allocation sizes", () => {
  test("reads nested columns, indexes and string overflow without a manifest", async () => {
    const directory = await mkdtemp(join(tmpdir(), "file-atlas-nested-"));
    const path = join(directory, "nested.duckdb");
    try {
      const sql = `CREATE TABLE nested AS SELECT i::INTEGER AS id, {'a':i,'b':i::VARCHAR} AS obj,
          [i,i+1] AS xs, [i,i+1]::BIGINT[2] AS arr, map(['k'],[i]) AS m FROM range(3000) t(i);
        CREATE INDEX nested_idx ON nested(id);
        SET force_compression='uncompressed';
        CREATE TABLE strings AS SELECT repeat(md5(i::VARCHAR),500) AS txt FROM range(40) t(i);
        CREATE TABLE fixed AS SELECT (i%1024)::INTEGER AS n FROM range(10000) t(i);
        CREATE TABLE empty_table(a INTEGER, b VARCHAR);
        CHECKPOINT;`;
      const child = Bun.spawn(
        [duckdb!, path, "-no-agent", "-batch", "-c", sql],
        { stdout: "pipe", stderr: "pipe" },
      );
      const stderr = await new Response(child.stderr).text();
      expect(await child.exited, stderr).toBe(0);
      const inspection = await inspectFile(Bun.file(path) as unknown as File);
      expect(inspection.native, inspection.warnings.join("\n")).toBeDefined();
      expect(inspection.native?.tables).toBe(4);
      expect(
        inspection.segments.some((segment) => segment.column === "xs.element"),
      ).toBe(true);
      expect(
        inspection.segments.some((segment) => segment.auxiliaryBlocks?.length),
      ).toBe(true);
      expect(inspection.blocks.some((block) => block.role === "index")).toBe(
        true,
      );
      expect(
        inspection.segments
          .filter(
            (segment) =>
              segment.table === "main.fixed" && segment.column === "n",
          )
          .reduce((sum, segment) => sum + (segment.byteSize ?? 0), 0),
      ).toBe(40000);
      for (const block of inspection.blocks.filter(
        (block) => block.role === "data" && block.usedBytes != null,
      )) {
        expect(block.ranges.reduce((sum, range) => sum + range.size, 0)).toBe(
          block.size,
        );
        expect(
          block.usedBytes! +
            block.ranges
              .filter((range) => range.kind === "unused")
              .reduce((sum, range) => sum + range.size, 0),
        ).toBe(block.size);
      }
      const list = inspection.segments.find(
        (segment) => segment.column === "xs.element",
      );
      expect(list?.rowCount).toBe(6000);
      expect(list?.rowGroupRowCount).toBe(3000);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }, 60000);
});

native("native catalog expressions and identifier identity", () => {
  test("reads simple views, scalar macros and generated columns without merging quoted names", async () => {
    const directory = await mkdtemp(join(tmpdir(), "file-atlas-catalog-"));
    const path = join(directory, "catalog.duckdb");
    try {
      const sql = `CREATE SCHEMA "a.b"; CREATE SCHEMA a;
        CREATE TABLE "a.b".c(id INTEGER PRIMARY KEY, "x.validity" INTEGER, x INTEGER DEFAULT 4,
          generated INTEGER GENERATED ALWAYS AS (x+1), CHECK(x>0));
        INSERT INTO "a.b".c VALUES (1,9,2),(2,10,3);
        CREATE TABLE a."b.c" AS SELECT i::DOUBLE AS d, i%2=0 AS b, i::FLOAT AS f,
          CURRENT_TIMESTAMP AS ts, TIME '12:30:00' AS tm, INTERVAL '2 days' AS iv,
          union_value(n:=i) AS u FROM range(1000) t(i);
        CREATE VIEW vv AS SELECT id FROM "a.b".c ORDER BY id LIMIT 2;
        CREATE MACRO inc(v) AS v+1; CHECKPOINT;`;
      const child = Bun.spawn(
        [duckdb!, path, "-no-agent", "-batch", "-c", sql],
        { stdout: "pipe", stderr: "pipe" },
      );
      const stderr = await new Response(child.stderr).text();
      expect(await child.exited, stderr).toBe(0);
      const inspection = await inspectFile(Bun.file(path) as unknown as File);
      expect(inspection.native, inspection.warnings.join("\n")).toBeDefined();
      expect(
        inspection.native!.catalog!.map((table) => table.name).sort(),
      ).toEqual(['"a.b".c', 'a."b.c"']);
      expect(
        inspection.native!.catalog!.find((table) => table.name === '"a.b".c')!
          .columns,
      ).toHaveLength(3);
      expect(
        new Set(inspection.segments.map((segment) => segment.id)).size,
      ).toBe(inspection.segments.length);
      const columns = new Set(
        inspection.segments.map((segment) => segment.column),
      );
      expect(columns.has('"x.validity"')).toBe(true);
      expect(columns.has("x.validity")).toBe(true);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }, 60000);
});
